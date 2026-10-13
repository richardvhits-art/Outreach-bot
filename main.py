"""
OutreachBot Backend — FastAPI
Handles: send messages, AI chat, follow-up scheduling
Channels: Email, LinkedIn, SMS (Twilio), WhatsApp (Twilio), Phone Call (Twilio)

Install:
  pip install fastapi uvicorn python-multipart twilio apscheduler anthropic python-dotenv

Run:
  uvicorn main:app --reload --port 8000
"""

from dotenv import load_dotenv
load_dotenv()

import json
import logging
import os
import smtplib
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from email.mime.text import MIMEText
from typing import Optional, List

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from apscheduler.schedulers.asyncio import AsyncIOScheduler

# ── Suppress /health and /fetch-replies spam in access logs ─────────────────
class _NoHealthFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        return '"/health"' not in msg and '"/fetch-replies"' not in msg

logging.getLogger("uvicorn.access").addFilter(_NoHealthFilter())

# ── Twilio ───────────────────────────────────────────────────────────────────
try:
    from twilio.rest import Client as TwilioClient
    TWILIO_SID           = os.getenv("TWILIO_SID", "")
    TWILIO_AUTH          = os.getenv("TWILIO_AUTH", "")
    TWILIO_FROM          = os.getenv("TWILIO_FROM", "")          # SMS + voice  e.g. +12295402975
    TWILIO_WHATSAPP_FROM = os.getenv("TWILIO_WHATSAPP_FROM", "") # WhatsApp     e.g. +14155238886
    twilio_client = TwilioClient(TWILIO_SID, TWILIO_AUTH) if TWILIO_SID else None
except ImportError:
    twilio_client = None
    TWILIO_FROM = TWILIO_WHATSAPP_FROM = ""

# ── Anthropic ────────────────────────────────────────────────────────────────
try:
    import anthropic
    _api_key = os.getenv("ANTHROPIC_API_KEY", "")
    ai_client = anthropic.Anthropic(api_key=_api_key) if _api_key else None
except ImportError:
    ai_client = None

# ── SMTP ─────────────────────────────────────────────────────────────────────
SMTP_HOST = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASS = os.getenv("SMTP_PASS", "")

# ── Sender / Brand Variables ─────────────────────────────────────────────────
SENDER_NAME  = os.getenv("SENDER_NAME",  "Vhits")
COMPANY_NAME = os.getenv("COMPANY_NAME", "Virtual Heights")
WEBSITE_NAME = os.getenv("WEBSITE_NAME", "Automation System")
WEBSITE_URL  = os.getenv("WEBSITE_URL",  "https://virtualheights.in")

# ── In-memory storage ─────────────────────────────────────────────────────────
logs: List[dict] = []
followup_queue: List[dict] = []

scheduler = AsyncIOScheduler()


@asynccontextmanager
async def lifespan(app: FastAPI):
    scheduler.start()
    yield
    scheduler.shutdown()


app = FastAPI(title="OutreachBot API", version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================
# Models
# ============================================================

class Contact(BaseModel):
    name:     Optional[str] = ""
    email:    Optional[str] = ""
    phone:    Optional[str] = ""
    linkedin: Optional[str] = ""
    whatsapp: Optional[str] = ""


class SendRequest(BaseModel):
    contact:    Contact
    message:    str
    channels:   List[str]
    isFollowup: bool = False


class ChatRequest(BaseModel):
    message:  str
    contacts: int = 0
    sent:     int = 0


# ============================================================
# Helpers
# ============================================================

DEFAULT_COUNTRY_CODE = os.getenv("DEFAULT_COUNTRY_CODE", "+91")


def normalize_phone(phone: str) -> str:
    """Ensure number has E.164 format with country code."""
    phone = phone.strip().replace(" ", "").replace("-", "")
    if not phone:
        return phone
    if not phone.startswith("+"):
        phone = DEFAULT_COUNTRY_CODE + phone
    return phone


def log_action(action: str, contact: str, detail: str = ""):
    logs.append({
        "timestamp": datetime.now().isoformat(),
        "action":    action,
        "contact":   contact,
        "detail":    detail,
    })


def local_parse(message: str) -> dict:
    m = message.lower()
    if "schedule" in m or "meeting" in m:
        return {"action": "schedule_meeting", "parameters": {"name": "unknown", "date": "tomorrow", "time": "10:00"}}
    if "email" in m and "send" in m:
        return {"action": "send_email", "parameters": {"to": "unknown", "subject": "Outreach", "message": message}}
    if "lead" in m or "save contact" in m:
        return {"action": "create_lead", "parameters": {"name": "unknown", "email": "", "phone": "", "source": "chatbot"}}
    return {"response": f"I received: '{message}'. How can I assist with your outreach?"}


# ============================================================
# Routes
# ============================================================

@app.get("/")
def root():
    return {"status": "OutreachBot running", "version": "2.0.0"}


@app.get("/health")
def health():
    issues = []
    if not SMTP_USER:            issues.append("SMTP_USER missing — email will not send")
    if not SMTP_PASS:            issues.append("SMTP_PASS missing — email will not send")
    if not TWILIO_SID:           issues.append("TWILIO_SID missing — SMS/WhatsApp/calls will not work")
    if not TWILIO_FROM:          issues.append("TWILIO_FROM missing — SMS/calls will not work")
    if not TWILIO_WHATSAPP_FROM: issues.append("TWILIO_WHATSAPP_FROM missing — WhatsApp will not work")

    return {
        "status":   "ok",
        "issues":   issues,
        "channels": {
            "email":    {"ready": bool(SMTP_USER and SMTP_PASS),              "from": SMTP_USER or "NOT SET"},
            "sms":      {"ready": bool(twilio_client and TWILIO_FROM),         "from": TWILIO_FROM or "NOT SET",
                         "note": "Twilio trial: recipient must be verified at console.twilio.com/verified-caller-ids"},
            "whatsapp": {"ready": bool(twilio_client and TWILIO_WHATSAPP_FROM),"from": TWILIO_WHATSAPP_FROM or "NOT SET"},
            "phone":    {"ready": bool(twilio_client and TWILIO_FROM),         "from": TWILIO_FROM or "NOT SET"},
            "linkedin": {"ready": True, "note": "Uses Playwright — browser opens on first use"},
        },
        "ai":          bool(ai_client),
        "country_code": DEFAULT_COUNTRY_CODE,
    }


@app.get("/config-check")
def config_check():
    """Detailed configuration check — open http://localhost:8000/config-check in browser."""
    env_tips = {
        "SMTP_USER":            {"set": bool(SMTP_USER),   "value": SMTP_USER or "(empty)",
                                  "tip": "Your Gmail address e.g. you@gmail.com"},
        "SMTP_PASS":            {"set": bool(SMTP_PASS),   "value": "*****" if SMTP_PASS else "(empty)",
                                  "tip": "Gmail App Password (16 chars) — NOT your login password. Get it at myaccount.google.com > Security > App Passwords"},
        "TWILIO_SID":           {"set": bool(TWILIO_SID),  "value": TWILIO_SID[:10]+"..." if TWILIO_SID else "(empty)",
                                  "tip": "From console.twilio.com > Account Info"},
        "TWILIO_AUTH":          {"set": bool(TWILIO_AUTH), "value": "*****" if TWILIO_AUTH else "(empty)",
                                  "tip": "Auth Token from console.twilio.com > Account Info"},
        "TWILIO_FROM":          {"set": bool(TWILIO_FROM), "value": TWILIO_FROM or "(empty)",
                                  "tip": "Your Twilio phone number e.g. +12295402975"},
        "TWILIO_WHATSAPP_FROM": {"set": bool(TWILIO_WHATSAPP_FROM), "value": TWILIO_WHATSAPP_FROM or "(empty)",
                                  "tip": "Twilio WhatsApp sandbox number e.g. +14155238886"},
        "LINKEDIN_EMAIL":       {"set": bool(os.getenv("LINKEDIN_EMAIL")),    "value": os.getenv("LINKEDIN_EMAIL","(empty)"),
                                  "tip": "Your LinkedIn login email"},
        "LINKEDIN_PASSWORD":    {"set": bool(os.getenv("LINKEDIN_PASSWORD")), "value": "*****" if os.getenv("LINKEDIN_PASSWORD") else "(empty)",
                                  "tip": "Your LinkedIn password"},
        "ANTHROPIC_API_KEY":    {"set": bool(os.getenv("ANTHROPIC_API_KEY")), "value": "*****" if os.getenv("ANTHROPIC_API_KEY") else "(empty)",
                                  "tip": "Optional — for AI chat assistant"},
    }
    missing = [k for k, v in env_tips.items() if not v["set"]]
    return {
        "all_set":     len(missing) == 0,
        "missing":     missing,
        "variables":   env_tips,
        "twilio_note": (
            "IMPORTANT: Twilio TRIAL accounts can ONLY send SMS/calls to VERIFIED numbers. "
            "Go to console.twilio.com > Phone Numbers > Verified Caller IDs > Add a number."
        ),
    }


@app.get("/sender-config")
def sender_config():
    """Return sender brand variables for the frontend."""
    return {
        "sender_name":  SENDER_NAME,
        "company_name": COMPANY_NAME,
        "website_name": WEBSITE_NAME,
        "website_url":  WEBSITE_URL,
    }


@app.post("/send")
async def send_message(req: SendRequest):
    """Send outreach message via selected channels."""
    results = {}

    # Resolve brand variables in the message text
    resolved_message = (req.message
        .replace("{{sender}}",  SENDER_NAME)
        .replace("{{company}}", COMPANY_NAME)
        .replace("{{website}}", WEBSITE_NAME)
        .replace("{{url}}",     WEBSITE_URL)
    )

    for raw_channel in req.channels:
        channel = raw_channel.lower().strip()   # ← normalize: "Phone" → "phone", "SMS" → "sms"

        try:
            if channel == "email":
                if not req.contact.email:
                    results["email"] = {"success": False, "error": "No email address provided"}
                else:
                    results["email"] = await send_email(req.contact, resolved_message)

            elif channel == "sms":
                if not req.contact.phone:
                    results["sms"] = {"success": False, "error": "No phone number provided for SMS"}
                else:
                    results["sms"] = send_sms(req.contact.phone, resolved_message)

            elif channel == "whatsapp":
                wa_number = req.contact.whatsapp or req.contact.phone
                if not wa_number:
                    results["whatsapp"] = {"success": False, "error": "No WhatsApp number provided"}
                else:
                    results["whatsapp"] = send_whatsapp(wa_number, resolved_message)

            elif channel == "phone":
                if not req.contact.phone:
                    results["phone"] = {"success": False, "error": "No phone number provided for call"}
                else:
                    results["phone"] = make_call(req.contact.phone, resolved_message)

            elif channel == "linkedin":
                results["linkedin"] = await send_linkedin_real(req.contact, resolved_message)

            else:
                results[raw_channel] = {"success": False, "error": f"Unknown channel: '{raw_channel}'"}

        except Exception as e:
            results[channel] = {"success": False, "error": str(e)}

    # Schedule follow-up
    if not req.isFollowup:
        followup_time = datetime.now() + timedelta(days=4)
        followup_queue.append({
            "contact":  req.contact.dict(),
            "message":  resolved_message,
            "channels": req.channels,
            "send_at":  followup_time.isoformat(),
            "sent":     False,
        })
        log_action(
            "followup_scheduled",
            req.contact.name or req.contact.email or req.contact.phone,
            f"Follow-up scheduled for {followup_time.strftime('%Y-%m-%d')}",
        )

    log_action(
        "followup_sent" if req.isFollowup else "message_sent",
        req.contact.name or req.contact.email or req.contact.phone,
        ", ".join(req.channels),
    )

    return {"success": True, "results": results, "followup_scheduled": not req.isFollowup}


@app.post("/chat")
async def chat(req: ChatRequest):
    system_prompt = f"""You are an AI Automation Assistant for OutreachBot.
Current stats: {req.contacts} contacts loaded, {req.sent} messages sent.

You understand user intent and respond:
- For action requests: respond ONLY with valid JSON matching this schema:
  {{"action": "<action>", "parameters": {{...}}}}
  Available actions: send_email, schedule_meeting, create_lead, get_info, pause_sending, resume_sending
- For questions/info: respond with plain text (no JSON)

Be concise and helpful."""

    if ai_client:
        try:
            response = ai_client.messages.create(
                model="claude-sonnet-4-20250514",
                max_tokens=500,
                system=system_prompt,
                messages=[{"role": "user", "content": req.message}],
            )
            text = response.content[0].text.strip()
            try:
                cleaned = text.replace("```json", "").replace("```", "").strip()
                data = json.loads(cleaned)
                if "action" in data:
                    return data
            except Exception:
                pass
            return {"response": text}
        except Exception as e:
            # AI call failed — fall back to local parser and log the reason
            log_action("ai_error", "chat", str(e))
            return local_parse(req.message)

    return local_parse(req.message)


@app.get("/followups")
def get_followups():
    return {"followups": followup_queue}


@app.post("/followups/{index}/send")
async def send_followup_by_index(index: int):
    if index >= len(followup_queue):
        raise HTTPException(status_code=404, detail="Follow-up not found")
    fu = followup_queue[index]
    if fu["sent"]:
        return {"message": "Already sent"}
    contact = Contact(**fu["contact"])
    req = SendRequest(contact=contact, message=fu["message"], channels=fu["channels"], isFollowup=True)
    result = await send_message(req)
    followup_queue[index]["sent"] = True
    return result


@app.get("/logs")
def get_logs():
    return {"logs": logs[-200:]}


# ============================================================
# Channel Implementations
# ============================================================

async def send_email(contact: Contact, message: str) -> dict:
    if not SMTP_USER or not SMTP_PASS:
        return {
            "success": False,
            "error": (
                "Email not configured. Add SMTP_USER and SMTP_PASS to .env. "
                "For Gmail: generate an App Password at myaccount.google.com → Security → App Passwords, "
                "then set SMTP_USER=you@gmail.com and SMTP_PASS=xxxx-xxxx-xxxx-xxxx"
            )
        }
    msg = MIMEText(message)
    msg["Subject"] = "Outreach from OutreachBot"
    msg["From"]    = SMTP_USER
    msg["To"]      = contact.email
    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
            server.starttls()
            server.login(SMTP_USER, SMTP_PASS)
            server.sendmail(SMTP_USER, contact.email, msg.as_string())
        return {"success": True, "to": contact.email, "from": SMTP_USER}
    except smtplib.SMTPAuthenticationError:
        return {"success": False, "error": "Gmail auth failed — use an App Password, not your regular password. myaccount.google.com → Security → App Passwords"}
    except smtplib.SMTPRecipientsRefused:
        return {"success": False, "error": f"Recipient refused: {contact.email} — check the email address"}
    except Exception as e:
        return {"success": False, "error": f"Email failed: {str(e)}"}


def send_sms(phone: str, message: str) -> dict:
    """Send SMS via Twilio. Uses TWILIO_FROM (+12295402975)."""
    if not twilio_client:
        return {"success": False, "error": "Twilio not configured. Set TWILIO_SID, TWILIO_AUTH in .env"}

    if not TWILIO_FROM:
        return {"success": False, "error": "TWILIO_FROM not set in .env (your SMS number e.g. +12295402975)"}

    phone = normalize_phone(phone)
    if not phone:
        return {"success": False, "error": "Phone number is empty"}

    try:
        msg = twilio_client.messages.create(
            body=message,
            from_=TWILIO_FROM,    
            to=phone,               
        )
        return {"success": True, "sid": msg.sid, "to": phone, "from": TWILIO_FROM}
    except Exception as e:
        error_msg = str(e)
        if "21211" in error_msg or "Invalid 'To' Phone Number" in error_msg:
            return {"success": False, "error": f"Invalid phone number: {phone}"}
        if "21608" in error_msg or "unverified" in error_msg.lower():
            return {"success": False, "error": f"Number {phone} is not verified in your Twilio trial. Verify at console.twilio.com/verified-caller-ids"}
        if "21614" in error_msg:
            return {"success": False, "error": f"{phone} cannot receive SMS (landline or restricted)"}
        return {"success": False, "error": f"SMS failed: {error_msg}"}


def send_whatsapp(phone: str, message: str) -> dict:
    """Send WhatsApp via Twilio sandbox. Uses TWILIO_WHATSAPP_FROM (+14155238886)."""
    if not twilio_client:
        return {"success": False, "error": "Twilio not configured"}

    if not TWILIO_WHATSAPP_FROM:
        return {"success": False, "error": "TWILIO_WHATSAPP_FROM not set in .env (WhatsApp sandbox number)"}

    phone = normalize_phone(phone)
    if not phone:
        return {"success": False, "error": "WhatsApp number is empty"}

    try:
        msg = twilio_client.messages.create(
            body=message,
            from_=f"whatsapp:{TWILIO_WHATSAPP_FROM}",   # whatsapp:+14155238886
            to=f"whatsapp:{phone}",                      # whatsapp:+919026932493
        )
        return {"success": True, "sid": msg.sid, "to": f"whatsapp:{phone}"}
    except Exception as e:
        error_msg = str(e)
        if "63007" in error_msg or "Channel" in error_msg:
            return {"success": False, "error": "WhatsApp sender misconfigured. Check TWILIO_WHATSAPP_FROM and sandbox at console.twilio.com/whatsapp/sandbox"}
        if "21408" in error_msg or "not verified" in error_msg.lower():
            return {"success": False, "error": f"{phone} has not joined the sandbox. They must WhatsApp the keyword to {TWILIO_WHATSAPP_FROM}"}
        return {"success": False, "error": f"WhatsApp failed: {error_msg}"}


def make_call(phone: str, message: str) -> dict:
    """Make a voice call via Twilio TwiML."""
    if not twilio_client:
        return {"success": False, "error": "Twilio not configured"}

    if not TWILIO_FROM:
        return {"success": False, "error": "TWILIO_FROM not set in .env"}

    phone = normalize_phone(phone)
    twiml = f"<Response><Say voice='alice'>{message}</Say></Response>"
    try:
        call = twilio_client.calls.create(twiml=twiml, from_=TWILIO_FROM, to=phone)
        return {"success": True, "sid": call.sid, "to": phone}
    except Exception as e:
        return {"success": False, "error": f"Call failed: {str(e)}"}


async def send_linkedin_real(contact: Contact, message: str) -> dict:
    """Send a real LinkedIn message using Playwright automation."""
    if not contact.linkedin:
        return {"success": False, "error": "No LinkedIn URL provided for this contact"}
    try:
        from linkedin_automation import send_linkedin_message
        result = await send_linkedin_message(
            linkedin_url=contact.linkedin,
            name=contact.name or "there",
            message=message,
        )
        return result
    except ImportError:
        return {"success": False, "error": "linkedin_automation.py not found — make sure it is in the same folder as main.py"}
    except Exception as e:
        return {"success": False, "error": f"LinkedIn automation error: {str(e)}"}


# ============================================================
# Scheduled Follow-up Checker (runs every hour)
# ============================================================

@scheduler.scheduled_job("interval", hours=1)
async def check_followups():
    now = datetime.now()
    for fu in followup_queue:
        if not fu["sent"] and datetime.fromisoformat(fu["send_at"]) <= now:
            contact = Contact(**fu["contact"])
            req = SendRequest(
                contact=contact,
                message=fu["message"],
                channels=fu["channels"],
                isFollowup=True,
            )
            await send_message(req)
            fu["sent"] = True
            print(f"[AutoFollow-up] Sent to {contact.name or contact.email or contact.phone}")


# ============================================================
# Gemini AI Template Generator
# ============================================================

import urllib.request

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL   = "gemini-flash-lite-latest"
GEMINI_ENDPOINT = (
    f"https://generativelanguage.googleapis.com/v1beta/models/"
    f"{GEMINI_MODEL}:generateContent"
)


class AIGenerateRequest(BaseModel):
    prompt: str


@app.post("/ai-generate")
async def ai_generate(req: AIGenerateRequest):
    """Proxy Gemini API call so the API key stays server-side."""
    if not GEMINI_API_KEY:
        raise HTTPException(
            status_code=503,
            detail="GEMINI_API_KEY not set in .env — add it to enable AI generation",
        )

    payload = json.dumps({
        "contents": [{"parts": [{"text": req.prompt}]}],
        "generationConfig": {"temperature": 0.8, "maxOutputTokens": 400},
    }).encode()

    url = f"{GEMINI_ENDPOINT}?key={GEMINI_API_KEY}"

    try:
        http_req = urllib.request.Request(
            url,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(http_req, timeout=20) as resp:
            body = json.loads(resp.read().decode())

        text = (
            body.get("candidates", [{}])[0]
            .get("content", {})
            .get("parts", [{}])[0]
            .get("text", "")
            .strip()
        )

        if not text:
            raise HTTPException(status_code=502, detail="Gemini returned an empty response")

        log_action("ai_generate", "gemini", f"prompt={req.prompt[:60]}")
        return {"text": text}

    except urllib.error.HTTPError as e:
        err_body = e.read().decode()
        try:
            err_msg = json.loads(err_body).get("error", {}).get("message", err_body)
        except Exception:
            err_msg = err_body
        raise HTTPException(status_code=e.code, detail=f"Gemini API error: {err_msg}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI generate failed: {str(e)}")


# ============================================================
# Fetch Replies  — /fetch-replies
# Polls Gmail (IMAP) for email replies and Twilio for
# inbound SMS / WhatsApp messages, then returns them so the
# frontend can match them to the correct contact card.
# ============================================================

import imaplib
import email as _email
from email.header import decode_header as _decode_header


def _decode_str(value: str) -> str:
    """Decode an RFC-2047 encoded email header string."""
    if not value:
        return ""
    parts = _decode_header(value)
    result = []
    for part, enc in parts:
        if isinstance(part, bytes):
            result.append(part.decode(enc or "utf-8", errors="replace"))
        else:
            result.append(part)
    return "".join(result)


class FetchRepliesRequest(BaseModel):
    """
    contacts: list of {name, email, phone} dicts — used for matching.
    since_minutes: how far back (in minutes) to look for messages.
    """
    contacts: List[dict] = []
    since_minutes: int = 60


@app.post("/fetch-replies")
async def fetch_replies(req: FetchRepliesRequest):
    """
    Returns:
      { replies: [ { channel, from, text, date, matched_email, matched_phone } ] }
    """
    replies = []

    # ── 1. EMAIL (Gmail IMAP) ─────────────────────────────────────────────────
    if SMTP_USER and SMTP_PASS:
        try:
            imap_host = os.getenv("IMAP_HOST", "imap.gmail.com")
            imap_port = int(os.getenv("IMAP_PORT", "993"))
            mail = imaplib.IMAP4_SSL(imap_host, imap_port)
            mail.login(SMTP_USER, SMTP_PASS)
            mail.select("INBOX")

            since_date = (datetime.now() - timedelta(minutes=req.since_minutes)).strftime("%d-%b-%Y")
            _, msg_ids = mail.search(None, f'(SINCE "{since_date}" NOT FROM "{SMTP_USER}")')

            for mid in (msg_ids[0].split() if msg_ids[0] else []):
                try:
                    _, msg_data = mail.fetch(mid, "(RFC822)")
                    raw = msg_data[0][1]
                    msg = _email.message_from_bytes(raw)

                    from_addr = _decode_str(msg.get("From", ""))
                    subject   = _decode_str(msg.get("Subject", ""))
                    date_str  = msg.get("Date", "")

                    # Extract plain-text body
                    body = ""
                    if msg.is_multipart():
                        for part in msg.walk():
                            if part.get_content_type() == "text/plain":
                                charset = part.get_content_charset() or "utf-8"
                                body = part.get_payload(decode=True).decode(charset, errors="replace")
                                break
                    else:
                        charset = msg.get_content_charset() or "utf-8"
                        body = msg.get_payload(decode=True).decode(charset, errors="replace")

                    # Strip quoted original message (lines starting with ">")
                    body_lines = [l for l in body.splitlines() if not l.startswith(">")]
                    body = "\n".join(body_lines).strip()
                    if not body:
                        continue

                    # Match against known contacts by email address
                    matched_email = ""
                    for c in req.contacts:
                        c_email = (c.get("email") or "").lower()
                        if c_email and c_email in from_addr.lower():
                            matched_email = c_email
                            break

                    replies.append({
                        "channel":       "email",
                        "from":          from_addr,
                        "subject":       subject,
                        "text":          body[:1000],
                        "date":          date_str,
                        "matched_email": matched_email,
                        "matched_phone": "",
                    })
                except Exception:
                    continue

            mail.logout()
        except Exception as e:
            log_action("fetch_replies_email_error", "imap", str(e))

    # ── 2. SMS / WHATSAPP (Twilio inbound messages) ───────────────────────────
    if twilio_client:
        try:
            since_dt = datetime.utcnow() - timedelta(minutes=req.since_minutes)

            for tw_msg in twilio_client.messages.list(date_sent_after=since_dt, limit=100):
                # Only inbound messages (direction = inbound)
                if tw_msg.direction not in ("inbound", "inbound-api"):
                    continue

                from_number = tw_msg.from_ or ""
                body        = (tw_msg.body or "").strip()
                if not body:
                    continue

                # Determine channel
                if "whatsapp:" in from_number.lower():
                    channel      = "whatsapp"
                    clean_number = from_number.replace("whatsapp:", "").strip()
                else:
                    channel      = "sms"
                    clean_number = from_number.strip()

                # Match against known contacts by phone
                matched_phone = ""
                for c in req.contacts:
                    c_phone = normalize_phone(c.get("phone") or c.get("whatsapp") or "")
                    if c_phone and c_phone in clean_number:
                        matched_phone = c_phone
                        break
                    # Also try without country code
                    raw_phone = (c.get("phone") or "").strip().lstrip("0")
                    if raw_phone and raw_phone in clean_number:
                        matched_phone = c_phone or raw_phone
                        break

                replies.append({
                    "channel":       channel,
                    "from":          from_number,
                    "subject":       "",
                    "text":          body[:1000],
                    "date":          tw_msg.date_sent.isoformat() if tw_msg.date_sent else "",
                    "matched_email": "",
                    "matched_phone": matched_phone,
                })
        except Exception as e:
            log_action("fetch_replies_twilio_error", "twilio", str(e))

    # LinkedIn replies cannot be fetched programmatically via API; user must paste manually.

    log_action("fetch_replies", "all", f"{len(replies)} replies found")
    return {"replies": replies}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)