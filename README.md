# ⚡ OutreachBot — AI Outreach Automation System

A full-stack outreach automation tool: upload contacts, send messages across multiple channels, and auto follow-up after 4–5 days.

---

## 📁 Project Structure

```
outreach-bot/
├── index.html          # Frontend UI
├── style.css           # Styling
├── app.js              # Frontend logic
├── main.py             # Python FastAPI backend
├── sample_contacts.csv # Sample CSV to test upload
└── README.md
```

---

## 🚀 Setup

### 1. Install Python dependencies

```bash
pip install fastapi uvicorn python-multipart aiosmtplib anthropic twilio apscheduler
```

### 2. Configure environment variables

Create a `.env` file or export these variables:

```bash
# Email (Gmail example)
export SMTP_HOST=smtp.gmail.com
export SMTP_PORT=587
export SMTP_USER=your@gmail.com
export SMTP_PASS=your_app_password

# Twilio (for SMS, WhatsApp, Phone)
export TWILIO_SID=ACxxxxxxxxxxxxxxxx
export TWILIO_AUTH=your_auth_token
export TWILIO_FROM=+1xxxxxxxxxx  # Your Twilio phone number

# Anthropic (for AI chat)
export ANTHROPIC_API_KEY=sk-ant-xxxxxxxx
```

### Twilio Setup Notes

- **Phone Numbers**: Use real phone numbers that can receive SMS/WhatsApp
- **Twilio Number**: Purchase a phone number from Twilio dashboard for sending
- **WhatsApp**: Enable WhatsApp sandbox or use approved numbers
- **Testing**: Use verified numbers from your Twilio account for testing

### 3. Run the backend

```bash
uvicorn main:app --reload --port 8000
```

### 4. Open the frontend

Open `index.html` in your browser (or serve with any HTTP server):

```bash
python -m http.server 3000
# then open http://localhost:3000
```

---

## 🎯 Features

| Feature | Description |
|---|---|
| 📄 Upload Contacts | CSV or JSON — bulk import with preview |
| ✉️ Message Template | Personalization with `{{name}}` variables |
| 📧 Email | Via SMTP (Gmail, Outlook, etc.) |
| 💬 SMS | Via Twilio |
| 📱 WhatsApp | Via Twilio WhatsApp API |
| 📞 Phone Call | Via Twilio Voice + TwiML |
| 💼 LinkedIn | Placeholder — connect Playwright/LinkedIn API |
| 🔁 Follow-up | Auto follow-up after 4–5 days |
| 🤖 AI Chat | Claude-powered command interface |
| 📊 Activity Logs | Exportable CSV logs |

---

## 📋 CSV Format

```csv
name,email,phone,linkedin,whatsapp
Alice Johnson,alice@example.com,+1234567890,https://linkedin.com/in/alice,+1234567890
```

## 📋 JSON Format

```json
[
  {
    "name": "Alice Johnson",
    "email": "alice@example.com",
    "phone": "+1234567890",
    "linkedin": "https://linkedin.com/in/alice",
    "whatsapp": "+1234567890"
  }
]
```

---

## 🔌 API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| GET | `/health` | Check integrations status |
| POST | `/send` | Send message to a contact |
| POST | `/chat` | AI chat + automation trigger |
| GET | `/followups` | List all follow-ups |
| POST | `/followups/{id}/send` | Manually send a follow-up |
| GET | `/logs` | Activity logs |

---

## 💬 Chat Commands

The built-in chatbot understands natural language:

- `"Send all messages"` → triggers Send All
- `"How many contacts?"` → shows stats
- `"Pause sending"` → pauses queue
- `"Open queue"` → navigates to queue tab
- `"Schedule a meeting tomorrow at 3pm"` → creates meeting action

---

## 🔐 Notes

- **Demo mode**: If backend is not running, the frontend works in demo mode (simulates sends)
- **LinkedIn**: Requires Playwright/Selenium automation or LinkedIn API access
- **Gmail**: Use App Passwords, not your regular password
- **Twilio Trial**: Free trial numbers can only message verified numbers

---

## 🛠️ Tech Stack

- **Frontend**: HTML5, CSS3 (CSS Variables, Grid, Flexbox), Vanilla JS
- **Backend**: Python 3.10+, FastAPI, APScheduler
- **Email**: SMTP (aiosmtplib)
- **SMS/WhatsApp/Phone**: Twilio
- **AI Chat**: Anthropic Claude API
- **File Formats**: CSV, JSON
