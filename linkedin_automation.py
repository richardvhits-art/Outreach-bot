"""
====================================================
  LinkedIn Playwright Automation — linkedin_automation.py
  Fixed: chat box detection after Message click
====================================================
"""

import os
import csv
import json
import logging
import asyncio
from datetime import datetime
from dotenv import load_dotenv
from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeout

load_dotenv()

LINKEDIN_EMAIL    = os.getenv("LINKEDIN_EMAIL", "")
LINKEDIN_PASSWORD = os.getenv("LINKEDIN_PASSWORD", "")
CONTACTS_FILE     = os.getenv("CONTACTS_FILE", "linkedin_contacts.csv")
LOG_FILE          = "linkedin_log.json"
HEADLESS          = os.getenv("HEADLESS", "false").lower() == "true"
DELAY_BETWEEN     = int(os.getenv("DELAY_BETWEEN_MSGS", "8"))

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

CONNECTION_NOTE = """Hi {name},

I came across your profile and would love to connect!

Best regards"""

FOLLOWUP_MESSAGE = """Hi {name},

Thanks for connecting! Would love to chat this week.

Best regards"""


class LinkedInAutomation:

    def __init__(self):
        self.browser   = None
        self.page      = None
        self.logged_in = False
        self.results   = []

    # ── Login (manual — you log in once, session is saved) ──────
    def _is_logged_in_url(self, url: str) -> bool:
        """Return True only if the URL proves we are actually logged in."""
        # These URLs only appear when authenticated
        LOGGED_IN = ["/feed", "/mynetwork", "/messaging", "/notifications", "/jobs"]
        # These URLs mean we are NOT logged in — even if "feed" appears as a redirect param
        LOGGED_OUT = ["linkedin.com/login", "linkedin.com/checkpoint",
                      "session_redirect", "authwall", "uas/login"]
        for bad in LOGGED_OUT:
            if bad in url:
                return False
        for good in LOGGED_IN:
            if good in url:
                return True
        return False

    async def login(self):
        """
        HOW THIS WORKS:
        - First run : browser opens, you log in MANUALLY, session saved to linkedin_session/
        - Next runs : session loads automatically — no login needed
        """
        current_url = self.page.url
        log.info(f"📍 Current URL: {current_url}")

        # Check if cookies already put us on a logged-in page
        if self._is_logged_in_url(current_url):
            log.info("✅ Session valid — already logged in!")
            self.logged_in = True
            return True

        # Cookies didn't work (expired/invalid) — need manual login
        log.warning("⚠️  Session expired or no session found.")
        log.warning("👉 Please log in manually in the browser window that opened.")
        log.warning("⏳ Waiting up to 3 minutes...")

        # Go to login page so the user sees the form
        await self.page.goto(
            "https://www.linkedin.com/login",
            wait_until="domcontentloaded",
            timeout=60000
        )
        await self.page.wait_for_timeout(1500)

        # Wait until URL becomes a genuine logged-in page
        try:
            await self.page.wait_for_function(
                """() => {
                    const url = window.location.href;
                    const bad = ["login", "checkpoint", "session_redirect", "authwall"];
                    if (bad.some(b => url.includes(b))) return false;
                    const good = ["/feed", "/mynetwork", "/messaging", "/jobs"];
                    return good.some(g => url.includes(g));
                }""",
                timeout=180000
            )
            log.info("✅ Manual login detected — session will be saved.")
            self.logged_in = True
            return True
        except Exception:
            log.error("❌ Login timed out after 3 minutes.")
            return False

    # ── Go to Profile ────────────────────────────────────────────
    async def go_to_profile(self, linkedin_url: str) -> bool:
        try:
            await self.page.goto(linkedin_url, wait_until="domcontentloaded", timeout=60000)
            await self.page.wait_for_timeout(4000)

            # Check final URL — LinkedIn redirects logged-out users to authwall/login
            final_url = self.page.url
            BAD = ["authwall", "login", "checkpoint", "session_redirect"]
            for bad in BAD:
                if bad in final_url:
                    log.error(f"❌ Redirected to logged-out page: {final_url}")
                    log.error("   Delete linkedin_session/ folder and run again to re-login.")
                    return False

            # Also check for logged-out buttons as a backup
            for sel in ['button:has-text("Agree & Join")', 'button:has-text("Sign in")']:
                el = await self.page.query_selector(sel)
                if el and await el.is_visible():
                    log.error("❌ Logged-out buttons detected on profile page.")
                    log.error("   Delete linkedin_session/ folder and run again to re-login.")
                    return False

            log.info(f"✅ Opened (logged in): {linkedin_url}")
            return True
        except Exception as e:
            log.error(f"❌ Could not open profile: {e}")
            return False

    # ── Find Button by Multiple Methods ─────────────────────────
    async def find_button(self, *labels) -> object:
        """Try multiple selectors to find a button."""
        for label in labels:
            # Method 1: button with exact text
            btn = await self.page.query_selector(f'button:has-text("{label}")')
            if btn:
                visible = await btn.is_visible()
                if visible:
                    log.info(f"✅ Found button: '{label}'")
                    return btn

            # Method 2: aria-label
            btn = await self.page.query_selector(f'button[aria-label*="{label}"]')
            if btn:
                visible = await btn.is_visible()
                if visible:
                    log.info(f"✅ Found button via aria: '{label}'")
                    return btn

            # Method 3: span inside button
            btn = await self.page.query_selector(f'span:has-text("{label}")')
            if btn:
                visible = await btn.is_visible()
                if visible:
                    log.info(f"✅ Found span button: '{label}'")
                    return btn

        log.warning(f"⚠️  Button not found: {labels}")
        return None

    # ── Debug — Print All Buttons on Page ───────────────────────
    async def debug_buttons(self):
        """Print all visible buttons — helps diagnose issues."""
        buttons = await self.page.query_selector_all('button')
        log.info(f"🔍 Found {len(buttons)} buttons on page:")
        for btn in buttons:
            try:
                text = await btn.inner_text()
                aria = await btn.get_attribute("aria-label")
                visible = await btn.is_visible()
                if visible and (text.strip() or aria):
                    log.info(f"   → Button: '{text.strip()}' | aria: '{aria}'")
            except:
                pass

    # ── Close ONLY blocking modals (NOT the message chat window) ─
    async def close_blocking_modal(self):
        """
        Close only modals that BLOCK interaction — never the message chat window.
        Does NOT press Escape (which would close the chat box too).
        """
        # LinkedIn "Premium upsell" or generic dismiss buttons
        dismiss_selectors = [
            'button[aria-label="Dismiss"]',
            'button[data-test-modal-close-btn]',
            'button.artdeco-modal__dismiss',
        ]
        for sel in dismiss_selectors:
            try:
                btn = await self.page.query_selector(sel)
                if btn and await btn.is_visible():
                    await btn.click()
                    await self.page.wait_for_timeout(800)
                    log.info(f"✅ Closed blocking modal via: {sel}")
                    return
            except:
                pass

    # ── Send Connection Request ──────────────────────────────────
    async def send_connection(self, name: str) -> dict:
        try:
            await self.page.wait_for_timeout(2000)

            # Debug — see what buttons are available
            await self.debug_buttons()

            # Try all possible Connect button variations
            connect_btn = await self.find_button(
                "Connect", "connect", "Follow", "Connect with"
            )

            # If not found — try More → Connect
            if not connect_btn:
                log.info("🔍 Trying More button...")
                more_btn = await self.find_button("More", "more")
                if more_btn:
                    await more_btn.click()
                    await self.page.wait_for_timeout(1500)
                    connect_btn = await self.find_button("Connect", "connect")

            if not connect_btn:
                log.warning(f"⚠️  Connect button not found for {name}")
                return {"success": False, "reason": "connect_button_not_found"}

            await connect_btn.click()
            await self.page.wait_for_timeout(2000)

            # Handle connection dialog
            send_btn = await self.find_button(
                "Send without a note", "Send", "Done", "Connect"
            )

            if send_btn:
                await send_btn.click()
                await self.page.wait_for_timeout(2000)
                log.info(f"✅ Connection sent to {name}")
                return {"success": True, "action": "connection_sent"}

            # Try adding note
            add_note_btn = await self.find_button("Add a note")
            if add_note_btn:
                await add_note_btn.click()
                await self.page.wait_for_timeout(1000)
                try:
                    msg = CONNECTION_NOTE.replace("{name}", name)
                    await self.page.fill('textarea[name="message"]', msg)
                    await self.page.wait_for_timeout(500)
                except:
                    pass
                send_btn = await self.find_button("Send", "Done")
                if send_btn:
                    await send_btn.click()
                    await self.page.wait_for_timeout(2000)
                    log.info(f"✅ Connection sent with note to {name}")
                    return {"success": True, "action": "connection_sent_with_note"}

            return {"success": False, "reason": "send_button_not_found"}

        except Exception as e:
            log.error(f"❌ Connection error for {name}: {e}")
            return {"success": False, "reason": str(e)}

    # ── Detect Connection State ──────────────────────────────────
    async def get_connection_state(self) -> str:
        """
        Returns:
          'connected'    — Message button is visible (already connected)
          'not_connected' — Connect button is visible (no connection yet)
          'pending'      — Pending / Message button may not exist
          'unknown'      — Can't determine
        """
        await self.page.wait_for_timeout(1500)

        # Check for Message button first (means already connected)
        all_btns = await self.page.query_selector_all('button')
        for btn in all_btns:
            try:
                text = (await btn.inner_text()).strip()
                aria = (await btn.get_attribute("aria-label") or "")
                visible = await btn.is_visible()
                if visible and text == "Message":
                    log.info("🔗 Connection state: CONNECTED (Message button found)")
                    return "connected"
            except:
                pass

        # Check for Connect button
        for btn in all_btns:
            try:
                text = (await btn.inner_text()).strip()
                aria = (await btn.get_attribute("aria-label") or "")
                visible = await btn.is_visible()
                if visible and ("Connect" in text or "Connect" in aria):
                    log.info("🔗 Connection state: NOT CONNECTED (Connect button found)")
                    return "not_connected"
            except:
                pass

        # Check pending state
        pending_sel = await self.page.query_selector('button:has-text("Pending")')
        if pending_sel and await pending_sel.is_visible():
            log.info("🔗 Connection state: PENDING")
            return "pending"

        log.warning("🔗 Connection state: UNKNOWN")
        return "unknown"

    # ── Send Connection Request WITH message note ────────────────
    async def send_connection_with_message(self, name: str, message: str) -> dict:
        """
        Click Connect → Add a note → type the message → Send.
        LinkedIn allows up to 300 chars in a connection note.
        If the note dialog doesn't appear, falls back to 'Send without a note'.
        """
        try:
            await self.page.wait_for_timeout(2000)
            await self.debug_buttons()

            # ── Find Connect button (not from 'People also viewed' section) ──
            connect_btn = None

            # Priority 1: aria-label containing the person's name
            try:
                connect_btn = await self.page.query_selector(
                    f'button[aria-label*="Invite {name}"]'
                )
                if connect_btn and not await connect_btn.is_visible():
                    connect_btn = None
            except:
                connect_btn = None

            # Priority 2: first visible Connect button in the profile action area
            if not connect_btn:
                all_btns = await self.page.query_selector_all('button')
                for btn in all_btns:
                    try:
                        text = (await btn.inner_text()).strip()
                        aria = (await btn.get_attribute("aria-label") or "")
                        visible = await btn.is_visible()
                        # Avoid "Connect" buttons inside suggestion cards
                        if visible and text == "Connect" and "Invite" in aria:
                            connect_btn = btn
                            log.info(f"✅ Found Connect button via aria: '{aria}'")
                            break
                    except:
                        pass

            # Priority 3: generic first visible Connect button on profile
            if not connect_btn:
                connect_btn = await self.find_button("Connect")

            if not connect_btn:
                # Try More → Connect
                log.info("🔍 Trying More → Connect...")
                more_btn = await self.find_button("More")
                if more_btn:
                    await more_btn.click()
                    await self.page.wait_for_timeout(1500)
                    connect_btn = await self.find_button("Connect")

            if not connect_btn:
                log.warning(f"⚠️  Connect button not found for {name}")
                return {"success": False, "reason": "connect_button_not_found"}

            log.info(f"🖱️  Clicking Connect button for {name}...")
            await connect_btn.click()
            await self.page.wait_for_timeout(2000)

            # ── Try to add note with message ─────────────────────
            add_note_btn = await self.find_button("Add a note")
            if add_note_btn:
                log.info("📝 Clicking 'Add a note'...")
                await add_note_btn.click()
                await self.page.wait_for_timeout(1000)

                # LinkedIn note textarea
                note_area = None
                for sel in ['textarea[name="message"]', 'textarea#connect-cta-form__invitation', 'textarea']:
                    try:
                        el = await self.page.query_selector(sel)
                        if el and await el.is_visible():
                            note_area = el
                            log.info(f"✅ Found note textarea: {sel}")
                            break
                    except:
                        pass

                if note_area:
                    # Trim message to 300 chars (LinkedIn note limit)
                    note_text = message[:300]
                    await note_area.click()
                    await self.page.wait_for_timeout(300)
                    await note_area.fill(note_text)
                    await self.page.wait_for_timeout(500)
                    log.info(f"📝 Typed note ({len(note_text)} chars)")

                    send_btn = await self.find_button("Send", "Done")
                    if send_btn:
                        await send_btn.click()
                        await self.page.wait_for_timeout(2000)
                        log.info(f"✅ Connection request + note sent to {name}")
                        return {
                            "success": True,
                            "action": "connection_sent_with_note",
                            "note": "Message included as connection note (max 300 chars)"
                        }

            # ── Fallback: send without note ──────────────────────
            log.warning("⚠️  Could not add note — sending connection without note...")
            send_btn = await self.find_button("Send without a note", "Send", "Done")
            if send_btn:
                await send_btn.click()
                await self.page.wait_for_timeout(2000)
                log.info(f"✅ Connection request sent (no note) to {name}")
                return {
                    "success": True,
                    "action": "connection_sent_no_note",
                    "note": "Connected without note — message will be sent after they accept"
                }

            return {"success": False, "reason": "send_button_not_found_after_connect_click"}

        except Exception as e:
            log.error(f"❌ connect_with_message error for {name}: {e}")
            return {"success": False, "reason": str(e)}

    # ── Wait for Chat Box ────────────────────────────────────────
    async def wait_for_chat_box(self, timeout_ms: int = 15000):
        """
        Wait up to timeout_ms for the LinkedIn chat/message box to appear.
        Returns the element or None.
        """
        selectors = [
            '.msg-form__contenteditable',
            'div.msg-form__contenteditable',
            'div[contenteditable="true"][role="textbox"]',
            'div[contenteditable="true"]',
            '[role="textbox"]',
            '.msg-form__textarea',
            # Newer LinkedIn selectors
            '.msg-s-message-list-content ~ div div[contenteditable]',
            '.msg-overlay-conversation-bubble--is-active div[contenteditable]',
        ]
        deadline = asyncio.get_event_loop().time() + timeout_ms / 1000
        while asyncio.get_event_loop().time() < deadline:
            for sel in selectors:
                try:
                    el = await self.page.query_selector(sel)
                    if el and await el.is_visible():
                        log.info(f"✅ Chat box appeared with selector: {sel}")
                        return el
                except:
                    pass
            await self.page.wait_for_timeout(500)
        return None

    # ── Send Direct Message ──────────────────────────────────────
    async def send_message(self, name: str, message: str) -> dict:
        """
        KEY FIX:
        - Close blocking modals BEFORE clicking Message (but NOT with Escape).
        - After clicking Message, wait patiently for the chat box.
        - Never press Escape after the Message button is clicked.
        """
        try:
            msg_text = message.replace("{name}", name)
            await self.page.wait_for_timeout(2000)

            # ── Close blocking overlays (no Escape) BEFORE clicking ──
            log.info("🔍 Closing any blocking modals (safe method)...")
            await self.close_blocking_modal()
            await self.page.wait_for_timeout(1000)

            await self.debug_buttons()

            # ── Find the profile-level Message button ───────────────
            # Use aria-label to pick the correct button (not sidebar ones)
            msg_btn = None

            # Priority 1: button with aria-label containing "Message <name>"
            try:
                msg_btn = await self.page.query_selector(
                    f'button[aria-label*="Message {name}"]'
                )
                if msg_btn and not await msg_btn.is_visible():
                    msg_btn = None
                if msg_btn:
                    log.info(f"✅ Found Message button via aria-label for {name}")
            except:
                msg_btn = None

            # Priority 2: generic "Message" button with aria "Message Shivani" pattern
            if not msg_btn:
                all_btns = await self.page.query_selector_all('button')
                for btn in all_btns:
                    try:
                        aria = await btn.get_attribute("aria-label") or ""
                        text = (await btn.inner_text()).strip()
                        visible = await btn.is_visible()
                        if visible and text == "Message" and "Message" in aria:
                            msg_btn = btn
                            log.info(f"✅ Found Message button: aria='{aria}'")
                            break
                    except:
                        pass

            # Priority 3: fallback — first visible "Message" button
            if not msg_btn:
                msg_btn = await self.find_button("Message", "Send message")

            if not msg_btn:
                log.warning(f"⚠️  Message button not found for {name}")
                return {"success": False, "reason": "not_connected_or_no_message_button"}

            # ── Click Message button ─────────────────────────────────
            log.info("🖱️  Clicking Message button...")
            try:
                await msg_btn.scroll_into_view_if_needed()
                await self.page.wait_for_timeout(500)
                await msg_btn.click()
                log.info("✅ Clicked Message button (normal click)")
            except Exception:
                try:
                    await self.page.evaluate("btn => btn.click()", msg_btn)
                    log.info("✅ Clicked Message button via JS")
                except Exception as e2:
                    log.warning(f"⚠️  Could not click Message button: {e2}")
                    return {"success": False, "reason": f"message_btn_click_failed: {e2}"}

            # ── Wait patiently for chat box — DO NOT press Escape here ──
            log.info("⏳ Waiting for chat box to appear (up to 15s)...")
            chat_box = await self.wait_for_chat_box(timeout_ms=15000)

            if not chat_box:
                log.warning("⚠️  Chat box not found — trying JS click fallback...")
                # One more attempt: JS click then wait again
                try:
                    await self.page.evaluate("btn => btn.click()", msg_btn)
                    await self.page.wait_for_timeout(2000)
                    chat_box = await self.wait_for_chat_box(timeout_ms=10000)
                except:
                    pass

            if not chat_box:
                log.warning("⚠️  Chat box still not found after retries")
                # Debug: print what's on the page now
                await self.debug_buttons()
                return {"success": False, "reason": "chat_box_not_found"}

            # ── Type message into chat box ───────────────────────────
            # LinkedIn uses a React contenteditable div.
            # Plain keyboard.type() doesn't trigger React's onChange,
            # so the send button stays disabled. We use clipboard paste
            # which fires all the right input events.

            await chat_box.click()
            await self.page.wait_for_timeout(800)

            # Make absolutely sure focus is on the chat box
            await chat_box.focus()
            await self.page.wait_for_timeout(300)

            # Clear any existing content
            await self.page.keyboard.press("Control+a")
            await self.page.wait_for_timeout(200)
            await self.page.keyboard.press("Backspace")
            await self.page.wait_for_timeout(200)

            # ── Paste via clipboard (triggers React state properly) ──
            log.info("📋 Pasting message via clipboard...")
            await self.page.evaluate(
                """async (text) => {
                    await navigator.clipboard.writeText(text);
                }""",
                msg_text
            )
            await self.page.wait_for_timeout(300)
            await self.page.keyboard.press("Control+v")
            await self.page.wait_for_timeout(1500)

            # ── Verify text actually appeared in the box ─────────────
            box_content = await self.page.evaluate(
                "(el) => el.innerText || el.textContent",
                chat_box
            )
            log.info(f"📝 Chat box content after paste: '{box_content[:80]}'")

            if not box_content.strip():
                # Fallback: use execCommand to insert text
                log.warning("⚠️  Clipboard paste failed — trying execCommand fallback...")
                await chat_box.click()
                await self.page.wait_for_timeout(300)
                await self.page.evaluate(
                    """(el, text) => {
                        el.focus();
                        document.execCommand('selectAll', false, null);
                        document.execCommand('delete', false, null);
                        document.execCommand('insertText', false, text);
                    }""",
                    chat_box, msg_text
                )
                await self.page.wait_for_timeout(1000)
                box_content = await self.page.evaluate(
                    "(el) => el.innerText || el.textContent", chat_box
                )
                log.info(f"📝 After execCommand: '{box_content[:80]}'")

            if not box_content.strip():
                log.error("❌ Could not type into chat box — message NOT sent")
                return {"success": False, "reason": "could_not_type_in_chat_box"}

            # ── Click the Send button (more reliable than Enter key) ──
            log.info("🚀 Looking for Send button to click...")
            send_btn = None
            send_selectors = [
                'button[aria-label="Send"]',
                'button.msg-form__send-button',
                'button[type="submit"].msg-form__send-button',
                '.msg-overlay-conversation-bubble--is-active button[aria-label="Send"]',
                '.msg-overlay-conversation-bubble--is-active button.msg-form__send-button',
            ]
            for sel in send_selectors:
                try:
                    btn = await self.page.query_selector(sel)
                    if btn and await btn.is_visible():
                        send_btn = btn
                        log.info(f"✅ Found Send button: {sel}")
                        break
                except:
                    pass

            if send_btn:
                # Check if Send button is enabled (not greyed out)
                is_disabled = await send_btn.get_attribute("disabled")
                if is_disabled is not None:
                    log.warning("⚠️  Send button is disabled — message text may not have registered")
                    # Last resort: press Enter
                    await chat_box.click()
                    await self.page.wait_for_timeout(300)
                    await self.page.keyboard.press("Enter")
                else:
                    await send_btn.click()
                    log.info("✅ Clicked Send button")
            else:
                # Fallback to Enter key
                log.info("⌨️  No Send button found — pressing Enter...")
                await chat_box.click()
                await self.page.wait_for_timeout(300)
                await self.page.keyboard.press("Enter")

            await self.page.wait_for_timeout(3000)

            # ── Verify message was actually sent ─────────────────────
            # After sending, the chat box should be empty
            box_after = await self.page.evaluate(
                "(el) => el.innerText || el.textContent", chat_box
            )
            if box_after.strip():
                log.warning(f"⚠️  Chat box still has text after send: '{box_after[:60]}' — may not have sent!")
                return {"success": False, "reason": "message_may_not_have_sent"}

            log.info(f"✅ Message successfully sent to {name} (chat box is now empty ✓)")
            return {"success": True, "action": "message_sent"}

        except Exception as e:
            log.error(f"❌ Message error for {name}: {e}")
            return {"success": False, "reason": str(e)}

    # ── Process Contact ──────────────────────────────────────────
    async def process_contact(self, contact: dict) -> dict:
        name         = contact.get("name", "there")
        linkedin_url = contact.get("linkedin", "")
        action       = contact.get("action", "connect")

        if not linkedin_url:
            return {"name": name, "success": False, "reason": "no_linkedin_url"}

        log.info(f"📋 Processing: {name} → {linkedin_url}")

        ok = await self.go_to_profile(linkedin_url)
        if not ok:
            return {"name": name, "success": False, "reason": "profile_not_found"}

        result = {}

        if action == "connect":
            result = await self.send_connection(name)
        elif action == "message":
            result = await self.send_message(name, FOLLOWUP_MESSAGE)
        elif action == "connect_and_message":
            result = await self.send_connection(name)
            await self.page.wait_for_timeout(3000)
            # Reload profile so Message button appears after connection
            await self.go_to_profile(linkedin_url)
            msg_result = await self.send_message(name, FOLLOWUP_MESSAGE)
            result["message_result"] = msg_result

        result["name"]         = name
        result["linkedin_url"] = linkedin_url
        result["timestamp"]    = datetime.now().isoformat()
        return result

    # ── Run ──────────────────────────────────────────────────────
    async def run(self, contacts: list):
        SESSION_DIR = "linkedin_session"

        async with async_playwright() as p:
            self.browser = await p.chromium.launch(
                headless=HEADLESS,
                slow_mo=80,
                args=[
                    "--no-sandbox",
                    "--disable-blink-features=AutomationControlled",
                    "--disable-dev-shm-usage",
                    "--start-maximized",
                    # Extra flags to look less like a bot
                    "--disable-infobars",
                    "--disable-extensions",
                ]
            )

            # ── Load saved session if it exists ──────────────────
            session_exists = os.path.isdir(SESSION_DIR) and os.path.exists(
                os.path.join(SESSION_DIR, "cookies.json")
            )

            context = await self.browser.new_context(
                user_agent=(
                    "Mozilla/5.0 (X11; Linux x86_64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/124.0.0.0 Safari/537.36"
                ),
                viewport={"width": 1366, "height": 768},
                java_script_enabled=True,
                locale="en-US",
                timezone_id="Asia/Kolkata",
            )

            # Anti-detection: hide webdriver flag
            await context.add_init_script(
                "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });"
            )

            self.page = await context.new_page()

            # ── Restore saved cookies if available ───────────────
            if session_exists:
                log.info(f"🍪 Loading saved session from {SESSION_DIR}/...")
                try:
                    with open(os.path.join(SESSION_DIR, "cookies.json")) as f:
                        cookies = json.load(f)

                    # CRITICAL: visit linkedin.com BEFORE adding cookies.
                    # Cookies only attach to a domain the browser has already
                    # visited. Without this step, add_cookies is silently ignored.
                    log.info("🌐 Visiting linkedin.com to anchor cookie domain...")
                    await self.page.goto(
                        "https://www.linkedin.com/",
                        wait_until="domcontentloaded",
                        timeout=30000
                    )
                    await self.page.wait_for_timeout(1500)

                    await context.add_cookies(cookies)
                    log.info(f"✅ Injected {len(cookies)} cookies — reloading to apply session...")

                    # Reload so LinkedIn reads the session cookie on this request
                    await self.page.goto(
                        "https://www.linkedin.com/feed/",
                        wait_until="domcontentloaded",
                        timeout=30000
                    )
                    await self.page.wait_for_timeout(2000)

                except Exception as e:
                    log.warning(f"⚠️  Could not load cookies: {e}")
            else:
                log.info("ℹ️  No saved session found — you will need to log in manually once.")

            # ── Login (manual if needed, instant if session valid) ─
            login_ok = await self.login()
            if not login_ok:
                log.error("❌ Cannot proceed without login")
                await self.browser.close()
                return []

            # ── Save session after successful login ───────────────
            os.makedirs(SESSION_DIR, exist_ok=True)
            cookies = await context.cookies()
            with open(os.path.join(SESSION_DIR, "cookies.json"), "w") as f:
                json.dump(cookies, f, indent=2)
            log.info(f"💾 Session saved to {SESSION_DIR}/ ({len(cookies)} cookies) — next run will skip login!")

            log.info(f"📋 Processing {len(contacts)} contacts...")

            for i, contact in enumerate(contacts):
                log.info(f"\n── Contact {i+1}/{len(contacts)} ──")
                result = await self.process_contact(contact)
                self.results.append(result)
                self.save_log()

                if i < len(contacts) - 1:
                    delay = DELAY_BETWEEN + (i % 3) * 2
                    log.info(f"⏳ Waiting {delay}s...")
                    await self.page.wait_for_timeout(delay * 1000)

            # Save final session state
            cookies = await context.cookies()
            with open(os.path.join(SESSION_DIR, "cookies.json"), "w") as f:
                json.dump(cookies, f, indent=2)

            await self.browser.close()
            return self.results

    def save_log(self):
        with open(LOG_FILE, "w") as f:
            json.dump(self.results, f, indent=2)

    def print_summary(self):
        success = sum(1 for r in self.results if r.get("success"))
        failed  = len(self.results) - success
        print(f"\n{'='*50}")
        print(f"📊 SUMMARY")
        print(f"{'='*50}")
        print(f"✅ Success : {success}")
        print(f"❌ Failed  : {failed}")
        print(f"📋 Total   : {len(self.results)}")
        print(f"💾 Log     : {LOG_FILE}")
        print(f"{'='*50}")


# ── Load CSV ─────────────────────────────────────────────────────
def load_contacts_from_csv(filepath: str) -> list:
    contacts = []
    try:
        with open(filepath, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                contacts.append({
                    "name":     (row.get("name") or "").strip(),
                    "linkedin": (row.get("linkedin") or "").strip(),
                    "action":   (row.get("action") or "connect").strip(),
                })
        log.info(f"📄 Loaded {len(contacts)} contacts from {filepath}")
    except FileNotFoundError:
        log.error(f"❌ File not found: {filepath}")
    return contacts


# ── Single message (OutreachBot integration) ─────────────────────
async def send_linkedin_message(linkedin_url: str, name: str, message: str) -> dict:
    """
    Called by OutreachBot (main.py) to send a single LinkedIn message.
    Reuses saved session cookies so no manual login is needed on repeat runs.
    """
    SESSION_DIR = "linkedin_session"
    bot = LinkedInAutomation()

    async with async_playwright() as p:
        bot.browser = await p.chromium.launch(
            headless=HEADLESS,
            slow_mo=80,
            args=[
                "--no-sandbox",
                "--disable-blink-features=AutomationControlled",
                "--disable-dev-shm-usage",
                "--start-maximized",
            ]
        )

        context = await bot.browser.new_context(
            user_agent=(
                "Mozilla/5.0 (X11; Linux x86_64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1366, "height": 768},
            java_script_enabled=True,
            locale="en-US",
            timezone_id="Asia/Kolkata",
        )
        await context.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });"
        )

        bot.page = await context.new_page()

        # ── Restore saved cookies if available ──────────────────
        session_exists = os.path.isdir(SESSION_DIR) and os.path.exists(
            os.path.join(SESSION_DIR, "cookies.json")
        )
        if session_exists:
            log.info(f"🍪 Loading saved LinkedIn session from {SESSION_DIR}/...")
            try:
                with open(os.path.join(SESSION_DIR, "cookies.json")) as f:
                    cookies = json.load(f)
                await bot.page.goto(
                    "https://www.linkedin.com/",
                    wait_until="domcontentloaded",
                    timeout=30000   
                )
                await bot.page.wait_for_timeout(1500)
                await context.add_cookies(cookies)
                await bot.page.goto(
                    "https://www.linkedin.com/feed/",
                    wait_until="domcontentloaded",
                    timeout=30000
                )
                await bot.page.wait_for_timeout(2000)
            except Exception as e:
                log.warning(f"⚠️  Could not load cookies: {e}")
        else:
            log.info("ℹ️  No saved session — manual login required once.")

        # ── Login ────────────────────────────────────────────────
        login_ok = await bot.login()
        if not login_ok:
            await bot.browser.close()
            return {"success": False, "reason": "login_failed"}

        # ── Save session after login ─────────────────────────────
        os.makedirs(SESSION_DIR, exist_ok=True)
        cookies = await context.cookies()
        with open(os.path.join(SESSION_DIR, "cookies.json"), "w") as f:
            json.dump(cookies, f, indent=2)

        # ── Navigate to profile ──────────────────────────────────
        ok = await bot.go_to_profile(linkedin_url)
        if not ok:
            await bot.browser.close()
            return {"success": False, "reason": "profile_not_found"}

        # ── Detect connection state ──────────────────────────────
        state = await bot.get_connection_state()
        log.info(f"🔗 Connection state for {name}: {state}")

        if state == "connected":
            # Already connected — send message directly
            log.info(f"✅ Already connected with {name} — sending message directly...")
            result = await bot.send_message(name, message)

        elif state == "not_connected":
            # Not connected — click Connect, add message as note, then send request
            log.info(f"🤝 Not connected with {name} — sending connection request with message note...")
            result = await bot.send_connection_with_message(name, message)

        elif state == "pending":
            log.warning(f"⏳ Connection request already pending for {name} — cannot send message yet")
            result = {"success": False, "reason": "connection_pending_cannot_message_yet"}

        else:
            # Unknown — try message first, fall back to connect_with_message
            log.warning(f"❓ Unknown state for {name} — trying message first, then connect...")
            result = await bot.send_message(name, message)
            if not result.get("success"):
                log.info("↩️  Message failed — attempting connect with message note...")
                result = await bot.send_connection_with_message(name, message)

        # Save updated session
        cookies = await context.cookies()
        with open(os.path.join(SESSION_DIR, "cookies.json"), "w") as f:
            json.dump(cookies, f, indent=2)

        await bot.browser.close()
        return result


# ── Main ─────────────────────────────────────────────────────────
async def main():
    print("⚡ LinkedIn Automation Starting...")
    print(f"📧 Account : {LINKEDIN_EMAIL}")
    print(f"📄 Contacts: {CONTACTS_FILE}")
    print(f"👁  Headless: {HEADLESS}")
    print("=" * 50)

    if not LINKEDIN_EMAIL or not LINKEDIN_PASSWORD:
        print("❌ Set LINKEDIN_EMAIL and LINKEDIN_PASSWORD in .env!")
        return

    contacts = load_contacts_from_csv(CONTACTS_FILE)
    if not contacts:
        print("❌ No contacts found in CSV!")
        return

    bot = LinkedInAutomation()
    await bot.run(contacts)
    bot.print_summary()


if __name__ == "__main__":
    asyncio.run(main())