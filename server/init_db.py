
import sqlite3
import os

DB_PATH = 'ib_reminder.db'

def init_db():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    # Create tables
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS ib_reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ib_id TEXT NOT NULL,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        contract_path TEXT,
        reminder_date TEXT NOT NULL,
        reminder_text TEXT,
        created_by TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
    ''')
    
    conn.commit()
    conn.close()
    print("Database initialized.")

if __name__ == '__main__':
    init_db()
