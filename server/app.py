
from flask import Flask, request, jsonify, send_from_directory, Response
from flask_cors import CORS
import sqlite3
import os
import json
from werkzeug.utils import secure_filename
from werkzeug.security import generate_password_hash, check_password_hash
import smtplib
import ssl
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
import threading
import time
import secrets
import string
from datetime import datetime
import math
import urllib.request
import urllib.parse
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), '.env'))

app = Flask(__name__, static_folder='../client', static_url_path='')
CORS(app)

# ── Configuration from .env ─────────────────────────────────
BASE_DIR       = os.path.dirname(os.path.abspath(__file__))
DB_PATH        = os.path.join(BASE_DIR, os.getenv('DB_PATH', 'ib_reminder.db'))
UPLOAD_FOLDER  = os.path.join(BASE_DIR, os.getenv('UPLOAD_FOLDER', 'uploads'))
MAX_UPLOAD_MB  = int(os.getenv('MAX_UPLOAD_MB', 20))
AUTH_API_URL   = os.getenv('AUTH_API_URL', 'https://myaccount.opofinance.com/client-api/login?version=1.0.0')
SMTP_SERVER    = os.getenv('SMTP_SERVER', 'smtp.gmail.com')
SMTP_PORT      = int(os.getenv('SMTP_PORT', 465))
SENDER_EMAIL   = os.getenv('SENDER_EMAIL', '')
SENDER_PASSWORD= os.getenv('SENDER_PASSWORD', '')
ALLOWED_EMAILS = [e.strip().lower() for e in os.getenv('ALLOWED_EMAILS', '').split(',') if e.strip()]
TELEGRAM_BOT_TOKEN = os.getenv('TELEGRAM_BOT_TOKEN', '')
# ────────────────────────────────────────────────────────────

if not os.path.exists(UPLOAD_FOLDER):
    os.makedirs(UPLOAD_FOLDER)

app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['MAX_CONTENT_LENGTH'] = MAX_UPLOAD_MB * 1024 * 1024


def get_db_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def run_migrations():
    """Safely add new columns and bootstrap the admin account."""
    conn = get_db_connection()
    cur  = conn.cursor()

    # ── Ensure tables exist before running migrations ────
    cur.execute('''CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        role TEXT NOT NULL DEFAULT 'IB',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        password_hash TEXT DEFAULT '',
        telegram_chat_id TEXT DEFAULT ''
    )''')
    
    cur.execute('''CREATE TABLE IF NOT EXISTS ib_reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ib_id TEXT NOT NULL,
        name TEXT DEFAULT '',
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        contract_path TEXT,
        reminder_date TEXT NOT NULL,
        reminder_text TEXT,
        created_by TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        targets TEXT DEFAULT '{}',
        payments TEXT DEFAULT '[]',
        is_sent INTEGER DEFAULT 0
    )''')
    
    cur.execute('''CREATE TABLE IF NOT EXISTS ib_campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ib_id TEXT NOT NULL,
        name TEXT DEFAULT '',
        clients TEXT,
        volume TEXT,
        reward TEXT,
        reward_paid TEXT,
        date TEXT,
        created_by TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )''')
    conn.commit()

    # ── users table: add password_hash/telegram_chat_id column if missing ──
    u_cols = [row[1] for row in cur.execute("PRAGMA table_info(users)").fetchall()]
    if 'password_hash' not in u_cols:
        cur.execute("ALTER TABLE users ADD COLUMN password_hash TEXT DEFAULT ''")
        print("[Migration] Added 'password_hash' column to users")
    if 'telegram_chat_id' not in u_cols:
        cur.execute("ALTER TABLE users ADD COLUMN telegram_chat_id TEXT DEFAULT ''")
        print("[Migration] Added 'telegram_chat_id' column to users")

    # ── Bootstrap admin account (nikan) ──────────────────
    # Read admin credentials from .env; fall back to env vars set at OS level
    admin_email = os.getenv('ADMIN_EMAIL', 'nikan@opofinance.com').lower().strip()
    admin_pass  = os.getenv('ADMIN_PASSWORD', 'Opo20232024!')
    admin_hash  = generate_password_hash(admin_pass)

    existing_admin = cur.execute(
        'SELECT id FROM users WHERE email = ?', (admin_email,)
    ).fetchone()

    if existing_admin:
        # Always refresh the admin password hash on startup
        cur.execute(
            'UPDATE users SET password_hash = ?, role = ? WHERE email = ?',
            (admin_hash, 'Admin', admin_email)
        )
    else:
        cur.execute(
            'INSERT INTO users (email, role, password_hash) VALUES (?, ?, ?)',
            (admin_email, 'Admin', admin_hash)
        )
    print(f"[Migration] Admin account ensured: {admin_email}")

    # ── ib_reminders — add columns if missing ─────────────
    r_cols = [row[1] for row in cur.execute("PRAGMA table_info(ib_reminders)").fetchall()]
    if 'name' not in r_cols:
        cur.execute("ALTER TABLE ib_reminders ADD COLUMN name TEXT DEFAULT ''")
        print("[Migration] Added 'name' column to ib_reminders")
    if 'targets' not in r_cols:
        cur.execute("ALTER TABLE ib_reminders ADD COLUMN targets TEXT DEFAULT '{}'")
        print("[Migration] Added 'targets' column to ib_reminders")
    if 'payments' not in r_cols:
        cur.execute("ALTER TABLE ib_reminders ADD COLUMN payments TEXT DEFAULT '[]'")
        print("[Migration] Added 'payments' column to ib_reminders")

    # ── ib_campaigns — add 'name' if missing ─────────────
    c_cols = [row[1] for row in cur.execute("PRAGMA table_info(ib_campaigns)").fetchall()]
    if 'name' not in c_cols:
        cur.execute("ALTER TABLE ib_campaigns ADD COLUMN name TEXT DEFAULT ''")
        print("[Migration] Added 'name' column to ib_campaigns")

    conn.commit()
    conn.close()

run_migrations()

TEMPLATE_PATH = os.path.join(os.path.dirname(__file__), 'email_template.html')

def build_email_html(reminder):
    """Load the HTML template and fill in reminder placeholders."""
    with open(TEMPLATE_PATH, 'r', encoding='utf-8') as f:
        html = f.read()
    html = html.replace('{{IB_ID}}',        str(reminder.get('ib_id', '')))
    html = html.replace('{{NAME}}',         str(reminder.get('name', '') or '—'))
    html = html.replace('{{START_DATE}}',   str(reminder.get('start_date', '')))
    html = html.replace('{{END_DATE}}',     str(reminder.get('end_date', '')))
    html = html.replace('{{REMINDER_DATE}}',str(reminder.get('reminder_date', '')))
    html = html.replace('{{CREATED_BY}}',   str(reminder.get('created_by', '')))
    html = html.replace('{{REMINDER_TEXT}}',str(reminder.get('reminder_text', '')))
    return html

def send_email(recipient, subject, reminder_data):
    try:
        msg = MIMEMultipart('alternative')
        msg['From'] = SENDER_EMAIL
        msg['To'] = recipient
        msg['Subject'] = subject

        # Plain text fallback
        plain = f"IB ID: {reminder_data.get('ib_id')}\nReminder: {reminder_data.get('reminder_text')}"
        msg.attach(MIMEText(plain, 'plain'))

        # HTML version
        html_body = build_email_html(reminder_data)
        msg.attach(MIMEText(html_body, 'html'))

        context = ssl.create_default_context()
        with smtplib.SMTP_SSL(SMTP_SERVER, SMTP_PORT, context=context) as server:
            server.login(SENDER_EMAIL, SENDER_PASSWORD)
            server.sendmail(SENDER_EMAIL, recipient, msg.as_string())
        return True
    except Exception as e:
        print(f"Error sending email to {recipient}: {str(e)}")
        return False

def send_telegram_message(chat_id, reminder_data):
    if not chat_id:
        return False
    text = f"<b>IB Contract Reminder</b>\n\n"
    text += f"<b>IB ID:</b> {reminder_data.get('ib_id')}\n"
    if reminder_data.get('name'):
        text += f"<b>Name:</b> {reminder_data.get('name')}\n"
    text += f"<b>Start Date:</b> {reminder_data.get('start_date')}\n"
    text += f"<b>End Date:</b> {reminder_data.get('end_date')}\n"
    text += f"<b>Reminder Date:</b> {reminder_data.get('reminder_date')}\n"
    text += f"<b>Created By:</b> {reminder_data.get('created_by')}\n"
    if reminder_data.get('reminder_text'):
        text += f"\n<b>Note:</b>\n{reminder_data.get('reminder_text')}"

    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = json.dumps({"chat_id": str(chat_id).strip(), "text": text, "parse_mode": "HTML"}).encode('utf-8')
    req = urllib.request.Request(url, data=payload, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req) as response:
            return response.status == 200
    except Exception as e:
        print(f"Telegram error: {e}")
        return False

def check_reminders_loop():
    """Runs every minute. At 07:00 on a reminder_date, sends email and marks is_sent=1."""
    while True:
        try:
            now   = datetime.now()
            today = now.strftime('%Y-%m-%d')

            # Only process at 07:00 (hour=7, minute=0..1 window)
            if now.hour == 7 and now.minute == 0:
                conn   = sqlite3.connect(DB_PATH)
                conn.row_factory = sqlite3.Row
                cursor = conn.cursor()
                # Fetch unsent reminders due today
                cursor.execute(
                    'SELECT * FROM ib_reminders WHERE reminder_date = ? AND is_sent = 0',
                    (today,)
                )
                reminders = cursor.fetchall()
                for r in reminders:
                    r_dict = dict(r)
                    created_by = r_dict['created_by']
                    
                    # Fetch telegram chat ID for creator
                    user_row = conn.execute('SELECT telegram_chat_id FROM users WHERE email = ?', (created_by,)).fetchone()
                    chat_id = user_row['telegram_chat_id'] if user_row else None
                    
                    email_success = send_email(created_by, "IB Contract Reminder", r_dict)
                    telegram_success = send_telegram_message(chat_id, r_dict)
                    
                    if email_success or telegram_success:
                        # Only mark sent when at least one delivery succeeds
                        cursor.execute(
                            'UPDATE ib_reminders SET is_sent = 1 WHERE id = ?',
                            (r_dict['id'],)
                        )
                        conn.commit()
                        print(f"[Scheduler 07:00] Auto-email/telegram sent for IB ID: {r_dict['ib_id']}")
                    else:
                        print(f"[Scheduler 07:00] Failed to send for IB ID: {r_dict['ib_id']}")
                
                # ── Cross-check target assignees for upcoming payments
                from datetime import timedelta
                cursor.execute('SELECT * FROM ib_reminders')
                all_contracts = cursor.fetchall()
                for r in all_contracts:
                    r_dict = dict(r)
                    try:
                        targets = json.loads(r_dict.get('targets', '{}'))
                        payments = json.loads(r_dict.get('payments', '[]'))
                    except Exception:
                        continue
                        
                    for p in payments:
                        status = p.get('status', 'Approval Pending')
                        if status not in ('Paid', 'Rejected', 'Canceled', 'Done'):
                            try:
                                p_date = datetime.strptime(p.get('date', ''), '%Y-%m-%d').date()
                            except Exception:
                                continue
                            
                            # From 2 days before payment date up to the payment date
                            if (p_date - timedelta(days=2)) <= now.date() <= p_date:
                                t_key = p.get('target_key')
                                assignee_email = targets.get(t_key, {}).get('assignee')
                                if assignee_email:
                                    # Fetch assignee user row for telegram
                                    u_row = conn.execute('SELECT telegram_chat_id FROM users WHERE email = ?', (assignee_email,)).fetchone()
                                    chat_id = u_row['telegram_chat_id'] if u_row else None
                                    
                                    text = "<b>🚨 Target Inspection Required!</b>\n"
                                    text += f"<b>IB ID:</b> {r_dict['ib_id']}\n"
                                    text += f"<b>Name:</b> {r_dict.get('name', '—')}\n"
                                    text += f"<b>Target:</b> {t_key}\n"
                                    text += f"<b>Payment Date:</b> {p.get('date')}\n"
                                    text += f"<b>Amount:</b> ${p.get('amount', 0)}\n\n"
                                    text += "Please login, specify the status (Approve/Reject) and leave a comment."
                                    
                                    # Telegram
                                    if chat_id:
                                        url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
                                        payload = json.dumps({"chat_id": str(chat_id).strip(), "text": text, "parse_mode": "HTML"}).encode('utf-8')
                                        req = urllib.request.Request(url, data=payload, headers={'Content-Type': 'application/json'})
                                        try:
                                            with urllib.request.urlopen(req) as resp:
                                                pass
                                        except Exception:
                                            pass
                                            
                                    # Email
                                    try:
                                        from email.mime.text import MIMEText
                                        msg = MIMEText(text.replace('\n', '<br>'), 'html', 'utf-8')
                                        msg['Subject'] = f"Action Required: Target Inspection - IB {r_dict['ib_id']}"
                                        msg['From'] = SENDER_EMAIL
                                        msg['To'] = assignee_email
                                        with smtplib.SMTP_SSL(SMTP_SERVER, SMTP_PORT) as server:
                                            server.login(SENDER_EMAIL, SENDER_PASSWORD)
                                            server.send_message(msg)
                                            print(f"Assignee email sent to {assignee_email} for target {t_key}")
                                    except Exception as ex:
                                        print(f"Failed to email assignee {assignee_email}: {ex}")

                conn.close()

        except Exception as e:
            print(f"Error in reminder loop: {str(e)}")

        # Sleep 60 seconds between checks (precise 07:00 window)
        time.sleep(60)

threading.Thread(target=check_reminders_loop, daemon=True).start()

@app.route('/')
def index():
    return send_from_directory(app.static_folder, 'index.html')

@app.route('/contract.html')
def contract_page():
    return send_from_directory(app.static_folder, 'contract.html')



@app.route('/api/login', methods=['POST'])
def login():
    data     = request.json or {}
    email    = data.get('email', '').lower().strip()
    password = data.get('password', '')

    if not email or not password:
        return jsonify({"success": False, "message": "Email and password are required."}), 400

    conn = get_db_connection()
    user = conn.execute('SELECT * FROM users WHERE email = ?', (email,)).fetchone()
    conn.close()

    if not user:
        return jsonify({"success": False, "message": "Invalid email or password."}), 401

    stored_hash = user['password_hash'] if user['password_hash'] else ''
    if not stored_hash or not check_password_hash(stored_hash, password):
        return jsonify({"success": False, "message": "Invalid email or password."}), 401

    return jsonify({"success": True, "email": email, "role": user['role']})

# ── User Management endpoints (Admin only) ────────────────────

def require_admin():
    """Helper: get email from header and verify it's an Admin."""
    email = request.headers.get('X-User-Email', '').lower().strip()
    conn = get_db_connection()
    user = conn.execute('SELECT role FROM users WHERE email = ?', (email,)).fetchone()
    conn.close()
    if not user or user['role'] != 'Admin':
        return None
    return email

@app.route('/api/team-members', methods=['GET'])
def get_team_members():
    """Return a list of all users' emails so they can be assigned to targets."""
    email = request.headers.get('X-User-Email', '').lower().strip()
    if not email:
        return jsonify([]), 403
    conn = get_db_connection()
    # List all users (id, email)
    rows = conn.execute('SELECT id, email FROM users ORDER BY email ASC').fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])

@app.route('/api/users', methods=['GET'])
def get_users():
    if not require_admin():
        return jsonify({"success": False, "message": "Admin access required."}), 403
    conn = get_db_connection()
    rows = conn.execute('SELECT id, email, role, created_at, telegram_chat_id FROM users ORDER BY created_at DESC').fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])

@app.route('/api/users', methods=['POST'])
def add_user():
    if not require_admin():
        return jsonify({"success": False, "message": "Admin access required."}), 403
    data     = request.json or {}
    email    = data.get('email', '').lower().strip()
    role     = data.get('role', 'IB')
    password = data.get('password', '').strip()
    chat_id  = data.get('telegram_chat_id', '').strip()

    if not email:
        return jsonify({"success": False, "message": "Email is required."}), 400
    if role not in ('Admin', 'IB', 'Account Manager', 'Backoffice'):
        return jsonify({"success": False, "message": "Invalid role."}), 400
    if not password:
        return jsonify({"success": False, "message": "Password is required."}), 400

    pw_hash = generate_password_hash(password)
    try:
        conn = get_db_connection()
        conn.execute(
            'INSERT INTO users (email, role, password_hash, telegram_chat_id) VALUES (?, ?, ?, ?)',
            (email, role, pw_hash, chat_id)
        )
        conn.commit()
        conn.close()
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "message": f"Email already exists or error: {str(e)}"}), 400

@app.route('/api/users/<int:user_id>', methods=['PUT'])
def update_user(user_id):
    if not require_admin():
        return jsonify({"success": False, "message": "Admin access required."}), 403
    data = request.json
    role = data.get('role', 'IB')
    chat_id = data.get('telegram_chat_id', '').strip()
    if role not in ('Admin', 'IB', 'Account Manager', 'Backoffice'):
        return jsonify({"success": False, "message": "Invalid role."}), 400
    conn = get_db_connection()
    conn.execute('UPDATE users SET role = ?, telegram_chat_id = ? WHERE id = ?', (role, chat_id, user_id))
    conn.commit()
    conn.close()
    return jsonify({"success": True})

@app.route('/api/users/<int:user_id>', methods=['DELETE'])
def delete_user(user_id):
    admin = require_admin()
    if not admin:
        return jsonify({"success": False, "message": "Admin access required."}), 403
    conn = get_db_connection()
    # Prevent deleting yourself
    target = conn.execute('SELECT email FROM users WHERE id = ?', (user_id,)).fetchone()
    if target and target['email'] == admin:
        conn.close()
        return jsonify({"success": False, "message": "You cannot delete your own account."}), 400
    conn.execute('DELETE FROM users WHERE id = ?', (user_id,))
    conn.commit()
    conn.close()
    return jsonify({"success": True})

@app.route('/api/users/<int:user_id>/reset-password', methods=['POST'])
def reset_user_password(user_id):
    """Admin sets a new password for a user."""
    if not require_admin():
        return jsonify({"success": False, "message": "Admin access required."}), 403
    data     = request.json or {}
    password = data.get('password', '').strip()
    if not password:
        return jsonify({"success": False, "message": "New password is required."}), 400
    pw_hash = generate_password_hash(password)
    conn = get_db_connection()
    conn.execute('UPDATE users SET password_hash = ? WHERE id = ?', (pw_hash, user_id))
    conn.commit()
    conn.close()
    return jsonify({"success": True})

@app.route('/api/users/generate-password', methods=['GET'])
def generate_password_api():
    """Generate a random secure password (Admin only)."""
    if not require_admin():
        return jsonify({"success": False, "message": "Admin access required."}), 403
    alphabet = string.ascii_letters + string.digits + '!@#$%'
    password = ''.join(secrets.choice(alphabet) for _ in range(14))
    return jsonify({"password": password})


@app.route('/api/ib-reminders', methods=['GET', 'POST'])
def handle_reminders():
    # Account Manager cannot access IB Reminder at all
    caller = request.headers.get('X-User-Email', request.form.get('created_by', '')).lower().strip()
    caller_role = get_user_role(caller) if caller else None
    if caller_role == 'Account Manager':
        return jsonify({"success": False, "message": "Access denied."}), 403

    if request.method == 'GET':
        search   = request.args.get('search', '')
        month    = request.args.get('month', '')   # YYYY-MM — calendar mode, no pagination
        page     = int(request.args.get('page', 1))
        per_page = 10
        conn     = get_db_connection()
        query    = "SELECT * FROM ib_reminders WHERE 1=1"
        params   = []

        if month:
            # Return ALL reminders whose reminder_date falls in this month (no pagination)
            query += " AND strftime('%Y-%m', reminder_date) = ?"
            params.append(month)
            rows = conn.execute(query + " ORDER BY reminder_date", params).fetchall()
            reminders = [dict(row) for row in rows]
            conn.close()
            return jsonify({"reminders": reminders, "total_pages": 1})

        if search:
            query += " AND (ib_id LIKE ? OR name LIKE ? OR reminder_text LIKE ? OR created_by LIKE ?)"
            params.extend([f"%{search}%", f"%{search}%", f"%{search}%", f"%{search}%"])
        total_count = conn.execute(query.replace("SELECT *", "SELECT COUNT(*)"), params).fetchone()[0]
        query += " ORDER BY created_at DESC LIMIT ? OFFSET ?"
        params.extend([per_page, (page - 1) * per_page])
        rows = conn.execute(query, params).fetchall()
        reminders = [dict(row) for row in rows]
        conn.close()
        return jsonify({"reminders": reminders, "total_pages": math.ceil(total_count / per_page)})

    
    # POST (New)
    ib_id         = request.form.get('ib_id')
    name          = request.form.get('name', '')
    start_date    = request.form.get('start_date')
    end_date      = request.form.get('end_date')
    reminder_date = request.form.get('reminder_date')
    reminder_text = request.form.get('reminder_text')
    created_by    = request.form.get('created_by')
    targets       = request.form.get('targets', '{}')
    payments      = request.form.get('payments', '[]')
    contract_file = request.files.get('contract')
    contract_path = ""
    if contract_file:
        filename = secure_filename(f"{ib_id}_{contract_file.filename}")
        contract_path = os.path.join(app.config['UPLOAD_FOLDER'], filename).replace('\\', '/')
        contract_file.save(contract_path)
    conn = get_db_connection()
    conn.execute(
        '''INSERT INTO ib_reminders
           (ib_id, name, start_date, end_date, contract_path, reminder_date, reminder_text, created_by, targets, payments)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
        (ib_id, name, start_date, end_date, contract_path, reminder_date, reminder_text, created_by, targets, payments)
    )
    conn.commit()
    conn.close()
    return jsonify({"success": True})

@app.route('/api/ib-reminders/<int:item_id>', methods=['GET', 'DELETE', 'PUT', 'POST'])
def handle_single_reminder(item_id):
    # Block Account Manager from all IB Reminder operations
    caller = request.headers.get('X-User-Email',
             request.form.get('created_by', '')).lower().strip()
    if get_user_role(caller) == 'Account Manager':
        return jsonify({"success": False, "message": "Access denied."}), 403

    conn = get_db_connection()

    if request.method == 'GET':
        row = conn.execute('SELECT * FROM ib_reminders WHERE id = ?', (item_id,)).fetchone()
        conn.close()
        if not row:
            return jsonify({"success": False, "message": "Contract not found."}), 404
        return jsonify({"success": True, "contract": dict(row)})
    if request.method == 'DELETE':
        conn.execute('DELETE FROM ib_reminders WHERE id = ?', (item_id,))
        conn.commit()
        conn.close()
        return jsonify({"success": True})
    
    if request.method == 'POST' and request.args.get('action') == 'send':
        # ── TEST SEND: sends email/telegram but does NOT change is_sent status ──
        r = conn.execute('SELECT * FROM ib_reminders WHERE id = ?', (item_id,)).fetchone()
        
        if r:
            r_dict = dict(r)
            created_by = r_dict['created_by']
            user_row = conn.execute('SELECT telegram_chat_id FROM users WHERE email = ?', (created_by,)).fetchone()
            chat_id = user_row['telegram_chat_id'] if user_row else None
            conn.close()
            
            email_success = send_email(
                created_by,
                f"[TEST] IB Contract Reminder — IB {r_dict['ib_id']}",
                r_dict
            )
            telegram_success = send_telegram_message(chat_id, r_dict)
            
            if email_success or telegram_success:
                return jsonify({"success": True, "message": "Test notification sent. Status remains Pending until 07:00 AM on reminder date."})
        else:
            conn.close()
        return jsonify({"success": False, "message": "Test send failed — check SMTP and Telegram settings."}), 500

    # PUT (Edit)
    ib_id         = request.form.get('ib_id')
    name          = request.form.get('name', '')
    start_date    = request.form.get('start_date')
    end_date      = request.form.get('end_date')
    reminder_date = request.form.get('reminder_date')
    reminder_text = request.form.get('reminder_text')
    targets       = request.form.get('targets', '{}')
    payments      = request.form.get('payments', '[]')
    contract_file = request.files.get('contract')
    if contract_file:
        filename = secure_filename(f"{ib_id}_{contract_file.filename}")
        contract_path = os.path.join(app.config['UPLOAD_FOLDER'], filename).replace('\\', '/')
        contract_file.save(contract_path)
        conn.execute('UPDATE ib_reminders SET ib_id=?, name=?, start_date=?, end_date=?, reminder_date=?, reminder_text=?, contract_path=?, targets=?, payments=? WHERE id=?',
                     (ib_id, name, start_date, end_date, reminder_date, reminder_text, contract_path, targets, payments, item_id))
    else:
        conn.execute('UPDATE ib_reminders SET ib_id=?, name=?, start_date=?, end_date=?, reminder_date=?, reminder_text=?, targets=?, payments=? WHERE id=?',
                     (ib_id, name, start_date, end_date, reminder_date, reminder_text, targets, payments, item_id))
    conn.commit()
    conn.close()
    return jsonify({"success": True})

@app.route('/api/ib-reminders/<int:item_id>/payment/<int:pay_idx>', methods=['PATCH'])
def update_payment_detail(item_id, pay_idx):
    """Backoffice or Admin updates the status/details of a specific payment entry."""
    caller = request.headers.get('X-User-Email', '').lower().strip()
    role   = get_user_role(caller) if caller else None
    if role not in ('Admin', 'Backoffice'):
        return jsonify({"success": False, "message": "Backoffice or Admin access required."}), 403

    data = request.json or {}
    conn = get_db_connection()
    row  = conn.execute('SELECT payments FROM ib_reminders WHERE id = ?', (item_id,)).fetchone()
    if not row:
        conn.close()
        return jsonify({"success": False, "message": "Contract not found."}), 404

    try:
        payments = json.loads(row['payments'] or '[]')
    except Exception:
        payments = []

    if pay_idx < 0 or pay_idx >= len(payments):
        conn.close()
        return jsonify({"success": False, "message": "Payment index out of range."}), 400

    payments[pay_idx]['status']      = data.get('status',      payments[pay_idx].get('status', 'Approval Pending'))
    payments[pay_idx]['paid_amount'] = data.get('paid_amount', payments[pay_idx].get('paid_amount', ''))
    payments[pay_idx]['hash_link']   = data.get('hash_link',   payments[pay_idx].get('hash_link', ''))
    payments[pay_idx]['comment']     = data.get('comment',     payments[pay_idx].get('comment', ''))

    conn.execute('UPDATE ib_reminders SET payments = ? WHERE id = ?',
                 (json.dumps(payments), item_id))
    conn.commit()
    conn.close()
    return jsonify({"success": True, "payments": payments})


@app.route('/api/todays-reminders', methods=['GET'])
def get_todays_reminders():
    caller = request.headers.get('X-User-Email', '').lower().strip()
    if get_user_role(caller) == 'Account Manager':
        return jsonify({"success": False, "message": "Access denied."}), 403
    today = datetime.now().strftime('%Y-%m-%d')
    conn = get_db_connection()
    rows = conn.execute('SELECT * FROM ib_reminders WHERE reminder_date = ?', (today,)).fetchall()
    reminders = [dict(row) for row in rows]
    conn.close()
    return jsonify(reminders)

@app.route('/api/payment-calendar', methods=['GET'])
def get_payment_calendar():
    caller = request.headers.get('X-User-Email', '').lower().strip()
    role = get_user_role(caller) if caller else None
    
    req_year = request.args.get('year', str(datetime.now().year))
    req_month = request.args.get('month', str(datetime.now().month))
    search = request.args.get('search', '').strip().lower()
    pay_status = request.args.get('status', '').strip()

    try:
        y = int(req_year)
        m = int(req_month)
    except ValueError:
        return jsonify({"success": False, "message": "Invalid year/month"}), 400

    conn = get_db_connection()
    query = "SELECT id, ib_id, name, created_by, payments FROM ib_reminders"
    params = []

    if role == 'Account Manager':
        query += " WHERE created_by = ?"
        params.append(caller)
        
    rows = conn.execute(query, params).fetchall()
    conn.close()

    payments_data = []
    
    for r in rows:
        ib_id_str = str(r['ib_id']).lower()
        name_str = (r['name'] or '').lower()
        
        if search and search not in ib_id_str and search not in name_str:
            continue
            
        try:
            payments = json.loads(r['payments'] or '[]')
        except Exception:
            payments = []
            
        for p in payments:
            date_str = p.get('date', '')
            if not date_str or len(date_str) < 7: continue
            
            try:
                p_year = int(date_str[0:4])
                p_month = int(date_str[5:7])
            except ValueError:
                continue
                
            if p_year == y and p_month == m:
                st = p.get('status', 'Approval Pending')
                if pay_status and st != pay_status:
                    continue
                    
                payments_data.append({
                    "contract_id": r['id'],
                    "ib_id": r['ib_id'],
                    "name": r['name'] or '—',
                    "date": date_str,
                    "amount": p.get('amount', 0),
                    "target_key": p.get('target_key', ''),
                    "status": st
                })
                
    # Sort payments by date
    payments_data.sort(key=lambda x: x['date'])
    return jsonify({"success": True, "payments": payments_data})

@app.route('/api/report/meta', methods=['GET'])
def get_report_meta():
    """Return distinct IB IDs and Names for filter autocomplete."""
    caller = request.headers.get('X-User-Email', '').lower().strip()
    if get_user_role(caller) == 'Account Manager':
        return jsonify({"success": False}), 403
    conn  = get_db_connection()
    rows  = conn.execute("SELECT DISTINCT ib_id, name FROM ib_reminders ORDER BY CAST(ib_id AS INTEGER)").fetchall()
    conn.close()
    ib_ids   = sorted(set(str(r['ib_id']) for r in rows if r['ib_id']), key=lambda x: int(x) if x.isdigit() else x)
    ib_names = sorted(set(r['name'].strip() for r in rows if r.get('name') and r['name'].strip()))
    return jsonify({'ib_ids': ib_ids, 'ib_names': ib_names})

@app.route('/api/report', methods=['GET'])
def get_report():
    """Aggregate report data for IB Contracts. Accessible to IB, Backoffice, Admin."""
    caller = request.headers.get('X-User-Email', '').lower().strip()
    role   = get_user_role(caller) if caller else None
    if role == 'Account Manager':
        return jsonify({"success": False, "message": "Access denied."}), 403

    date_from      = request.args.get('date_from',      '')
    date_to        = request.args.get('date_to',        '')
    filter_ib_id   = request.args.get('ib_id',          '').strip()
    filter_ib_name = request.args.get('ib_name',        '').strip().lower()
    filter_pay_st  = request.args.get('payment_status', '')   # Approval Pending|Payment Pending|Paid|Rejected
    filter_target  = request.args.get('target_type',    '')   # net_deposit|ftd|...
    filter_assignee = request.args.get('assignee',      '').strip().lower()

    conn   = get_db_connection()
    query  = "SELECT * FROM ib_reminders WHERE 1=1"
    params = []

    if date_from:
        query += " AND end_date >= ?";  params.append(date_from)
    if date_to:
        query += " AND end_date <= ?";  params.append(date_to)
    if filter_ib_id:
        query += " AND CAST(ib_id AS TEXT) = ?"; params.append(filter_ib_id)
    if filter_ib_name:
        query += " AND LOWER(name) LIKE ?"; params.append(f"%{filter_ib_name}%")

    rows      = conn.execute(query + " ORDER BY end_date", params).fetchall()
    contracts = [dict(row) for row in rows]
    conn.close()

    TARGET_KEYS = ['net_deposit', 'ftd', 'deposit', 'pr', 'marketing']
    TARGET_LABELS = {
        'net_deposit': 'Net Deposit', 'ftd': 'FTD',
        'deposit': 'Deposit', 'pr': 'PR', 'marketing': 'Marketing'
    }
    today_str = datetime.now().strftime('%Y-%m-%d')

    summary = {
        'total_contracts': 0,
        'active': 0, 'expired': 0,
        'total_expected': 0, 'total_paid': 0,
        'payments_pending': 0, 'payments_done': 0, 'payments_canceled': 0,
        'payments_paid': 0,
        'by_target': {k: {'expected': 0, 'paid': 0, 'count': 0} for k in TARGET_KEYS},
    }
    report_rows = []

    for c in contracts:
        try:  targets  = json.loads(c.get('targets')  or '{}')
        except: targets = {}
        try:  payments = json.loads(c.get('payments') or '[]')
        except: payments = []

        # ── Target type filter: skip contract if target not enabled ──
        if filter_target and not targets.get(filter_target, {}).get('enabled'):
            continue

        # ── Assignee filter: skip contract if no target matches the assignee ──
        if filter_assignee:
            # check if any enabled target has this assignee
            has_assignee = False
            for k, t_data in targets.items():
                if t_data.get('enabled') and str(t_data.get('assignee', '')).strip().lower() == filter_assignee:
                    has_assignee = True
                    break
            if not has_assignee:
                continue

        # ── Payment status filter: skip contract if no payment matches ──
        if filter_pay_st and not any(
            (p.get('status', 'Approval Pending') == filter_pay_st) for p in payments
        ):
            continue

        active = c.get('end_date', '') >= today_str
        if active: summary['active']  += 1
        else:      summary['expired'] += 1
        summary['total_contracts'] += 1

        c_expected = sum(float(p.get('amount', 0) or 0) for p in payments)
        c_paid     = sum(float(p.get('paid_amount', 0) or 0) for p in payments if p.get('status') == 'Paid')
        summary['total_expected'] += c_expected
        summary['total_paid']     += c_paid

        for p in payments:
            st = p.get('status', 'Approval Pending')
            if st == 'Paid':              summary['payments_paid']     += 1
            elif st == 'Payment Pending': summary['payments_done']     += 1
            elif st == 'Rejected':        summary['payments_canceled'] += 1
            else:                         summary['payments_pending']  += 1

            tk = p.get('target_key', '')
            if tk in TARGET_KEYS:
                summary['by_target'][tk]['count']    += 1
                summary['by_target'][tk]['expected'] += float(p.get('amount', 0) or 0)
                if st == 'Paid':
                    summary['by_target'][tk]['paid'] += float(p.get('paid_amount', 0) or 0)

        active_targets = []
        for k in TARGET_KEYS:
            t_data = targets.get(k, {})
            if t_data.get('enabled'):
                name_parts = [TARGET_LABELS.get(k, k)]
                if t_data.get('assignee'):
                    name_parts.append(f"({t_data['assignee'].split('@')[0]})")
                active_targets.append(' '.join(name_parts))
                
        report_rows.append({
            'id':             c['id'],
            'ib_id':          c['ib_id'],
            'name':           c.get('name', ''),
            'start_date':     c.get('start_date', ''),
            'end_date':       c.get('end_date', ''),
            'reminder_date':  c.get('reminder_date', ''),
            'created_by':     c.get('created_by', ''),
            'is_sent':        c.get('is_sent', 0),
            'active':         active,
            'targets':        active_targets,
            'total_expected': c_expected,
            'total_paid':     c_paid,
            'payments_count': len(payments),
            'payments_done':  sum(1 for p in payments if p.get('status') == 'Paid'),
            'payments_pending': sum(1 for p in payments if p.get('status', 'Approval Pending') in ('Approval Pending', 'Payment Pending')),
            'payments':       payments,
        })

    return jsonify({
        'summary': summary, 'contracts': report_rows,
        'generated_at': datetime.now().strftime('%Y-%m-%d %H:%M'),
        'filters': {
            'date_from': date_from, 'date_to': date_to,
            'ib_id': filter_ib_id, 'ib_name': filter_ib_name,
            'payment_status': filter_pay_st, 'target_type': filter_target,
        }
    })

@app.route('/uploads/<path:filename>')
def uploaded_file(filename):
    return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

@app.route('/api/email-preview')
def email_preview():
    """Return the rendered HTML email template for preview in the browser."""
    item_id = request.args.get('id')
    if item_id:
        conn = get_db_connection()
        r = conn.execute('SELECT * FROM ib_reminders WHERE id = ?', (item_id,)).fetchone()
        conn.close()
        if r:
            return build_email_html(dict(r)), 200, {'Content-Type': 'text/html; charset=utf-8'}
    sample = {
        'ib_id': '123456', 'start_date': '2026-01-01', 'end_date': '2026-12-31',
        'reminder_date': '2026-02-23', 'created_by': 'nikan@opofinance.com',
        'reminder_text': 'This is a sample reminder text.\n\nPlease review the contract details and take appropriate action before the deadline.'
    }
    return build_email_html(sample), 200, {'Content-Type': 'text/html; charset=utf-8'}

# ── IB Campaigns ──────────────────────────────────────────────

def get_user_role(email):
    conn = get_db_connection()
    user = conn.execute('SELECT role FROM users WHERE email = ?', (email,)).fetchone()
    conn.close()
    return user['role'] if user else None

@app.route('/api/ib-campaigns', methods=['GET', 'POST'])
def handle_campaigns():
    if request.method == 'GET':
        search   = request.args.get('search', '')
        sort_by  = request.args.get('sort_by', 'created_at')   # campaign_start | campaign_end | created_at
        sort_dir = request.args.get('sort_dir', 'desc').upper()
        page     = int(request.args.get('page', 1))
        per_page = 10

        # Whitelist sort columns
        allowed_sorts = {'campaign_start', 'campaign_end', 'created_at', 'ib_id'}
        if sort_by not in allowed_sorts:
            sort_by = 'created_at'
        if sort_dir not in ('ASC', 'DESC'):
            sort_dir = 'DESC'

        conn   = get_db_connection()
        query  = "SELECT * FROM ib_campaigns WHERE 1=1"
        params = []
        if search:
            query += " AND (ib_id LIKE ? OR name LIKE ? OR ib_manager LIKE ? OR offer LIKE ?)"
            params.extend([f"%{search}%", f"%{search}%", f"%{search}%", f"%{search}%"])

        total_count = conn.execute(query.replace("SELECT *", "SELECT COUNT(*)"), params).fetchone()[0]
        query += f" ORDER BY {sort_by} {sort_dir} LIMIT ? OFFSET ?"
        params.extend([per_page, (page - 1) * per_page])

        rows = conn.execute(query, params).fetchall()
        conn.close()

        today = datetime.now().strftime('%Y-%m-%d')
        campaigns = []
        for row in rows:
            r = dict(row)
            if r['campaign_start'] <= today <= r['campaign_end']:
                r['status'] = 'Active'
            else:
                r['status'] = 'Deactive'
            campaigns.append(r)

        return jsonify({
            "campaigns": campaigns,
            "total_pages": math.ceil(total_count / per_page) if total_count else 1,
            "total_count": total_count
        })

    # POST — only Admin and IB can add
    caller_email = request.form.get('created_by', '')
    role = get_user_role(caller_email)
    if role not in ('Admin', 'IB'):
        return jsonify({"success": False, "message": "Only Admin and IB users can add campaigns."}), 403

    ib_id          = request.form.get('ib_id')
    name           = request.form.get('name', '')
    campaign_start = request.form.get('campaign_start')
    campaign_end   = request.form.get('campaign_end')
    offer          = request.form.get('offer', '')
    keypoints      = request.form.get('keypoints', '')
    ib_manager     = request.form.get('ib_manager', 'Mani')
    created_by     = caller_email

    conn = get_db_connection()
    conn.execute(
        '''INSERT INTO ib_campaigns (ib_id, name, campaign_start, campaign_end, offer, keypoints, ib_manager, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)''',
        (ib_id, name, campaign_start, campaign_end, offer, keypoints, ib_manager, created_by)
    )
    conn.commit()
    conn.close()
    return jsonify({"success": True})

@app.route('/api/ib-campaigns/<int:item_id>', methods=['PUT', 'DELETE'])
def handle_single_campaign(item_id):
    caller_email = request.headers.get('X-User-Email', '')
    role = get_user_role(caller_email)

    if request.method == 'DELETE':
        if role not in ('Admin', 'IB'):
            return jsonify({"success": False, "message": "Permission denied."}), 403
        conn = get_db_connection()
        conn.execute('DELETE FROM ib_campaigns WHERE id = ?', (item_id,))
        conn.commit()
        conn.close()
        return jsonify({"success": True})

    # PUT (Edit) — Admin and IB only
    if role not in ('Admin', 'IB'):
        return jsonify({"success": False, "message": "Permission denied."}), 403

    ib_id          = request.form.get('ib_id')
    name           = request.form.get('name', '')
    campaign_start = request.form.get('campaign_start')
    campaign_end   = request.form.get('campaign_end')
    offer          = request.form.get('offer', '')
    keypoints      = request.form.get('keypoints', '')
    ib_manager     = request.form.get('ib_manager', 'Mani')

    conn = get_db_connection()
    conn.execute('''UPDATE ib_campaigns
                    SET ib_id=?, name=?, campaign_start=?, campaign_end=?, offer=?, keypoints=?, ib_manager=?
                    WHERE id=?''',
                 (ib_id, name, campaign_start, campaign_end, offer, keypoints, ib_manager, item_id))
    conn.commit()
    conn.close()
    return jsonify({"success": True})

@app.route('/api/ib-campaigns/export', methods=['GET'])
def export_campaigns():
    """Return ALL campaigns (no pagination) for CSV/PDF export, with optional filters."""
    status_filter = request.args.get('status', 'all').lower()  # all | active | deactive
    date_from     = request.args.get('date_from', '')
    date_to       = request.args.get('date_to', '')

    conn   = get_db_connection()
    query  = "SELECT * FROM ib_campaigns WHERE 1=1"
    params = []

    if date_from:
        query += " AND campaign_start >= ?"
        params.append(date_from)
    if date_to:
        query += " AND campaign_start <= ?"
        params.append(date_to)

    query += " ORDER BY campaign_start DESC"
    rows  = conn.execute(query, params).fetchall()
    conn.close()

    today = datetime.now().strftime('%Y-%m-%d')
    result = []
    for row in rows:
        r = dict(row)
        r['status'] = 'Active' if r['campaign_start'] <= today <= r['campaign_end'] else 'Deactive'
        if status_filter == 'active'   and r['status'] != 'Active':   continue
        if status_filter == 'deactive' and r['status'] != 'Deactive': continue
        result.append(r)

    return jsonify(result)

# ── Server-side PDF export (Persian font support) ─────────────

@app.route('/api/ib-campaigns/export-pdf', methods=['GET'])
def export_campaigns_pdf():
    try:
        from fpdf import FPDF
        import arabic_reshaper
        from bidi.algorithm import get_display
    except ImportError as e:
        return jsonify({"error": f"Missing library: {e}"}), 500

    status_filter = request.args.get('status', 'all').lower()
    date_from     = request.args.get('date_from', '')
    date_to       = request.args.get('date_to', '')

    # Fetch data
    conn   = get_db_connection()
    query  = "SELECT * FROM ib_campaigns WHERE 1=1"
    params = []
    if date_from:
        query  += " AND campaign_start >= ?"
        params.append(date_from)
    if date_to:
        query  += " AND campaign_start <= ?"
        params.append(date_to)
    query += " ORDER BY campaign_start DESC"
    rows  = conn.execute(query, params).fetchall()
    conn.close()

    today = datetime.now().strftime('%Y-%m-%d')
    data  = []
    for row in rows:
        r = dict(row)
        r['status'] = 'Active' if r['campaign_start'] <= today <= r['campaign_end'] else 'Deactive'
        if status_filter == 'active'   and r['status'] != 'Active':   continue
        if status_filter == 'deactive' and r['status'] != 'Deactive': continue
        data.append(r)

    FONT_PATH = os.path.join(os.path.dirname(__file__), 'Vazirmatn-Regular.ttf')

    def fix(text):
        """Reshape + bidi for correct Persian/Arabic rendering."""
        if not text:
            return ''
        try:
            reshaped = arabic_reshaper.reshape(str(text))
            return get_display(reshaped)
        except Exception:
            return str(text)

    class PDF(FPDF):
        def header(self):
            self.set_fill_color(79, 70, 229)
            self.rect(0, 0, 297, 18, 'F')
            self.add_font('Vazir', '', FONT_PATH)
            self.set_font('Vazir', size=12)
            self.set_text_color(255, 255, 255)
            self.set_xy(10, 5)
            self.cell(0, 8, fix('Opo IB Portal — صادرات IB Campaigns'), align='R')
            self.set_xy(180, 5)
            gen_text = f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}"
            self.set_font('Helvetica', size=7)
            self.cell(0, 8, gen_text, align='R')
            self.ln(14)

    pdf = PDF(orientation='L', unit='mm', format='A4')
    pdf.set_auto_page_break(auto=True, margin=12)
    pdf.add_page()
    pdf.add_font('Vazir', '', FONT_PATH)

    # Table header
    col_widths = [22, 28, 28, 50, 70, 28, 24]
    headers    = ['IB ID', 'Start', 'End', 'Offer', 'Keypoints', 'Manager', 'Status']

    pdf.set_fill_color(99, 102, 241)
    pdf.set_text_color(255, 255, 255)
    pdf.set_font('Vazir', size=8)
    for w, h in zip(col_widths, headers):
        pdf.cell(w, 8, h, border=1, align='C', fill=True)
    pdf.ln()

    # Rows
    fill = False
    for r in data:
        pdf.set_fill_color(31, 31, 35) if fill else pdf.set_fill_color(24, 24, 27)
        fill = not fill

        status_color = (74, 222, 128) if r['status'] == 'Active' else (248, 113, 113)
        cells = [
            (col_widths[0], str(r['ib_id']),         'C'),
            (col_widths[1], r['campaign_start'],      'C'),
            (col_widths[2], r['campaign_end'],        'C'),
            (col_widths[3], fix(r.get('offer', '')),  'R'),
            (col_widths[4], fix(r.get('keypoints', '') or ''), 'R'),
            (col_widths[5], r['ib_manager'],           'C'),
        ]
        pdf.set_text_color(210, 210, 210)
        pdf.set_font('Vazir', size=7)
        for w, txt, align in cells:
            # Truncate long text
            if len(txt) > 60:
                txt = txt[:58] + '…'
            pdf.cell(w, 7, txt, border=1, align=align, fill=True)

        # Status cell with colored text
        pdf.set_text_color(*status_color)
        pdf.cell(col_widths[6], 7, r['status'], border=1, align='C', fill=True)
        pdf.ln()

    # Footer
    pdf.set_y(-12)
    pdf.set_font('Helvetica', size=7)
    pdf.set_text_color(100)
    pdf.cell(0, 6, f'Total: {len(data)} records  ·  Opo IB Portal', align='C')

    pdf_bytes = bytes(pdf.output())
    return Response(
        pdf_bytes,
        mimetype='application/pdf',
        headers={
            'Content-Disposition': f'attachment; filename="ib_campaigns_{today}.pdf"',
            'Content-Length': len(pdf_bytes)
        }
    )

if __name__ == '__main__':
    port = int(os.getenv('PORT') or os.getenv('FLASK_PORT') or 5000)
    app.run(host='0.0.0.0', port=port, debug=True)
