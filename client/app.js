
const API_BASE = 'http://localhost:5000/api';
const SESSION_DURATION = 60 * 60 * 1000; // 1 hour in ms

let currentUser = localStorage.getItem('ib_user');
let currentRole = localStorage.getItem('ib_role');
let currentPage = 1;
let currentReminders = [];
let currentCampaigns = [];
let campPage = 1;
let sessionTimer = null;
let countdownTimer = null;
let _teamMembers = [];

// Role badge styles
const ROLE_STYLES = {
    'Admin': { bg: '#4f46e5', label: '👑 Admin' },
    'IB': { bg: '#0f766e', label: '📊 IB' },
    'Account Manager': { bg: '#b45309', label: '💼 Account Manager' },
};

// ── Session helpers ─────────────────────────────────────────

function stampSession() {
    localStorage.setItem('ib_login_time', Date.now().toString());
}

function sessionAge() {
    const t = localStorage.getItem('ib_login_time');
    return t ? Date.now() - parseInt(t, 10) : Infinity;
}

function sessionValid() {
    return currentUser && sessionAge() < SESSION_DURATION;
}

function clearSession() {
    localStorage.removeItem('ib_user');
    localStorage.removeItem('ib_role');
    localStorage.removeItem('ib_login_time');
    currentUser = null;
    currentRole = null;
    clearInterval(sessionTimer);
    clearInterval(countdownTimer);
}

function startSessionWatchdog() {
    // Silent countdown — no display, only used for auto-logout check
    // Auto-logout watchdog (check every 30 s)
    sessionTimer = setInterval(() => {
        if (!sessionValid()) {
            clearSession();
            alert('Your session has expired. Please log in again.');
            location.reload();
        }
    }, 30_000);
}

// ── Remember Me helpers ──────────────────────────────────────

function saveCredentials(email, password) {
    localStorage.setItem('ib_remember_email', email);
    // Simple obfuscation (base64) — adequate for internal tool
    localStorage.setItem('ib_remember_pass', btoa(password));
    localStorage.setItem('ib_remember', '1');
}

function clearCredentials() {
    localStorage.removeItem('ib_remember_email');
    localStorage.removeItem('ib_remember_pass');
    localStorage.removeItem('ib_remember');
}

function loadSavedCredentials() {
    if (localStorage.getItem('ib_remember') === '1') {
        const email = localStorage.getItem('ib_remember_email') || '';
        const pass = localStorage.getItem('ib_remember_pass') || '';
        document.getElementById('email').value = email;
        document.getElementById('password').value = pass ? atob(pass) : '';
        document.getElementById('remember-me').checked = true;
    }
}

// ── Toggle password visibility ───────────────────────────────

function togglePassword() {
    const input = document.getElementById('password');
    const icon = document.getElementById('eye-icon');
    if (input.type === 'password') {
        input.type = 'text';
        icon.classList.replace('fa-eye', 'fa-eye-slash');
    } else {
        input.type = 'password';
        icon.classList.replace('fa-eye-slash', 'fa-eye');
    }
}

// ── Page load ────────────────────────────────────────────────

loadSavedCredentials();

if (sessionValid()) {
    showDashboard();
} else {
    clearSession(); // clean up any stale state
}

function showDashboard() {
    document.getElementById('login-page').style.display = 'none';
    document.getElementById('dashboard-page').style.display = 'block';
    document.getElementById('user-email').innerText = currentUser;

    // Role badge
    const style = ROLE_STYLES[currentRole] || { bg: '#52525b', label: currentRole };
    document.getElementById('user-role-badge').innerHTML =
        `<span style="background:${style.bg};color:#fff;padding:2px 10px;border-radius:999px;font-size:0.75rem;font-weight:600;">${style.label}</span>`;

    // Control Panel for Admin only
    if (currentRole === 'Admin') {
        document.getElementById('control-panel-btn').style.display = 'inline-flex';
    }

    // ── Role-based layout ────────────────────────────────────
    if (currentRole === 'Account Manager') {
        // Hide IB Reminder tab completely
        document.getElementById('tab-reminder').style.display = 'none';
        // Auto-switch to Campaigns tab
        switchTab('campaigns');
    } else {
        // Admin & IB see IB Reminder by default
        fetchTeamMembers();
        fetchReminders();
        fetchTodaysReminders();
        loadCalendar();
    }

    startSessionWatchdog();
}


function logout() {
    clearSession();
    location.reload();
}


// ── Login form handler ───────────────────────────────────────

document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const rememberMe = document.getElementById('remember-me').checked;
    const errorEl = document.getElementById('login-error');

    errorEl.style.display = 'none';

    // Immediately show loading state
    const submitBtn = e.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing in…';

    try {
        const response = await fetch(`${API_BASE}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });

        const data = await response.json();
        if (data.success) {
            localStorage.setItem('ib_user', data.email);
            localStorage.setItem('ib_role', data.role);
            currentUser = data.email;
            currentRole = data.role;
            stampSession();

            if (rememberMe) saveCredentials(email, password);
            else clearCredentials();

            showDashboard();
        } else {
            errorEl.innerText = data.message || 'Login failed';
            errorEl.style.display = 'block';
        }
    } catch (err) {
        errorEl.innerText = 'Server error. Please try again later.';
        errorEl.style.display = 'block';
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Login';
    }
});

// ── Calendar state ────────────────────────────────────────────
let calendarMode = false;
let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth(); // 0-based

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

function toggleCalendarView() {
    calendarMode = !calendarMode;
    const btn = document.getElementById('calendar-view-btn');
    const tableCard = document.querySelector('#section-reminder .table-card');
    const pag = document.getElementById('pagination');
    const todaysSec = document.querySelector('#section-reminder > div[style*="margin-top: 4rem"]') ||
        document.querySelector('#section-reminder > div[style*="margin-top:4rem"]');
    const searchBox = document.getElementById('contract-search-box');
    const calEl = document.getElementById('calendar-container');

    if (calendarMode) {
        btn.innerHTML = '<i class="fa fa-table"></i> Table View';
        tableCard.style.display = 'none';
        pag.style.display = 'none';
        if (todaysSec) todaysSec.style.display = 'none';
        searchBox.style.display = 'none';
        calEl.style.display = 'block';
        calYear = new Date().getFullYear();
        calMonth = new Date().getMonth();
        renderCalendar();
    } else {
        btn.innerHTML = '<i class="fa fa-calendar-alt"></i> Calendar View';
        tableCard.style.display = '';
        pag.style.display = '';
        if (todaysSec) todaysSec.style.display = '';
        searchBox.style.display = '';
        calEl.style.display = 'none';
        fetchReminders(currentPage);
    }
}

function calNav(dir) {
    calMonth += dir;
    if (calMonth > 11) { calMonth = 0; calYear++; }
    if (calMonth < 0) { calMonth = 11; calYear--; }
    renderCalendar();
}

async function renderCalendar() {
    const monthStr = `${calYear}-${String(calMonth + 1).padStart(2, '0')}`;
    document.getElementById('cal-title').textContent = `${MONTH_NAMES[calMonth]} ${calYear}`;

    // Fetch all reminders for this month
    const res = await fetch(`${API_BASE}/ib-reminders?month=${monthStr}`, {
        headers: { 'X-User-Email': currentUser || '' }
    });
    const data = await res.json();
    const reminders = data.reminders || [];

    // Build a map: date-string → [reminder, ...]
    const byDay = {};
    reminders.forEach(r => {
        const d = r.reminder_date;
        if (!byDay[d]) byDay[d] = [];
        byDay[d].push(r);
    });

    const grid = document.getElementById('cal-grid');
    const firstDay = new Date(calYear, calMonth, 1).getDay(); // 0=Sun
    const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
    const daysInPrev = new Date(calYear, calMonth, 0).getDate();
    const todayStr = new Date().toISOString().slice(0, 10);

    const totalCells = Math.ceil((firstDay + daysInMonth) / 7) * 7;
    let html = '';

    for (let i = 0; i < totalCells; i++) {
        let dayNum, dateStr, isOther = false;

        if (i < firstDay) {
            dayNum = daysInPrev - firstDay + i + 1;
            const pm = calMonth === 0 ? 12 : calMonth;
            const py = calMonth === 0 ? calYear - 1 : calYear;
            dateStr = `${py}-${String(pm).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
            isOther = true;
        } else if (i >= firstDay + daysInMonth) {
            dayNum = i - firstDay - daysInMonth + 1;
            const nm = calMonth === 11 ? 1 : calMonth + 2;
            const ny = calMonth === 11 ? calYear + 1 : calYear;
            dateStr = `${ny}-${String(nm).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
            isOther = true;
        } else {
            dayNum = i - firstDay + 1;
            dateStr = `${calYear}-${String(calMonth + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
        }

        const isToday = dateStr === todayStr;
        const dayItems = byDay[dateStr] || [];
        const canEdit = currentRole === 'Admin' || currentRole === 'IB';

        const chips = dayItems.map(r =>
            `<div class="cal-chip ${r.is_sent ? 'sent' : ''}"
                  onclick="event.stopPropagation();showReminderDetail(${r.id})"
                  title="IB ${r.ib_id} — ${r.reminder_text || ''}">
                IB ${r.ib_id}
             </div>`
        ).join('');

        const addBtn = canEdit
            ? `<button class="cal-add-btn" onclick="event.stopPropagation();openModalForDate('${dateStr}')" title="Add contract">＋</button>`
            : '';

        html += `
            <div class="cal-day ${isOther ? 'other-month' : ''} ${isToday ? 'today' : ''}">
                <div class="cal-day-num">
                    <span>${dayNum}</span>
                    ${addBtn}
                </div>
                ${chips}
            </div>`;
    }

    grid.innerHTML = html;
}

// Open Add modal pre-filled with a specific reminder_date from calendar
function openModalForDate(dateStr) {
    // Reset form fresh then open
    openModal();
    // Wait for modal to render (openModal may reset fields), then set the date
    setTimeout(() => {
        const el = document.getElementById('reminder_date');
        if (el) {
            el.value = dateStr;
            // Visually highlight the pre-filled field so user knows it's set
            el.style.borderColor = '#6366f1';
            el.style.boxShadow = '0 0 0 2px rgba(99,102,241,0.3)';
            setTimeout(() => {
                el.style.borderColor = '';
                el.style.boxShadow = '';
            }, 2000);
        }
    }, 80);
}

// Show detail of a specific reminder (reuse existing reminder data)
function showReminderDetail(id) {
    const r = currentReminders.find(x => x.id === id);
    if (!r) {
        // If not in currentReminders (calendar loads separately), fetch from page data
        fetchAndShowDetail(id);
        return;
    }
    openReminderDetailModal(r);
}

async function fetchAndShowDetail(id) {
    try {
        // Fetch the month data we already have on the calendar
        const monthStr = `${calYear}-${String(calMonth + 1).padStart(2, '0')}`;
        const res = await fetch(`${API_BASE}/ib-reminders?month=${monthStr}`, {
            headers: { 'X-User-Email': currentUser || '' }
        });
        const data = await res.json();
        const r = (data.reminders || []).find(x => x.id === id);
        if (r) openReminderDetailModal(r);
    } catch (e) { console.error(e); }
}

function openReminderDetailModal(r) {
    const statusColor = r.is_sent ? '#4ade80' : '#fbbf24';
    const statusLabel = r.is_sent ? '✅ Sent' : '⏳ Pending';
    const field = (label, value) => `
        <div style="background:#27272a;border-radius:0.6rem;padding:0.9rem 1.1rem;">
            <div style="font-size:0.72rem;color:#71717a;text-transform:uppercase;letter-spacing:1px;margin-bottom:0.3rem;">${label}</div>
            <div style="color:#fafafa;font-size:0.9rem;line-height:1.6;white-space:pre-wrap;">${value || '—'}</div>
        </div>`;

    document.getElementById('camp-detail-body').innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;">
            ${field('IB ID', r.ib_id)}
            ${field('Status', `<span style="color:${statusColor}">${statusLabel}</span>`)}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;">
            ${field('Start Date', r.start_date)}
            ${field('End Date', r.end_date)}
        </div>
        ${field('Reminder Date', r.reminder_date)}
        ${field('Reminder Text', r.reminder_text)}
        ${r.contract_path
            ? `<div style="background:#27272a;border-radius:0.6rem;padding:0.9rem 1.1rem;">
                <div style="font-size:0.72rem;color:#71717a;text-transform:uppercase;letter-spacing:1px;margin-bottom:0.3rem;">Contract</div>
                <a href="http://localhost:5000/${r.contract_path}" target="_blank"
                   style="color:#818cf8;font-size:0.85rem;">📎 View Contract</a>
               </div>` : ''}
        <div style="font-size:0.75rem;color:#52525b;text-align:right;">
            Added by ${r.created_by}
        </div>`;

    document.getElementById('camp-detail-modal').querySelector('h2').innerHTML =
        '<i class="fa fa-file-contract" style="color:#6366f1;margin-right:0.5rem;"></i> Contract Details';
    document.getElementById('camp-detail-modal').style.display = 'flex';
}


async function fetchReminders(page = 1) {
    currentPage = page;
    const search = document.getElementById('search-input').value;
    try {
        const response = await fetch(`${API_BASE}/ib-reminders?page=${page}&search=${search}`, {
            headers: { 'X-User-Email': currentUser || '' }
        });
        const data = await response.json();
        currentReminders = data.reminders || [];
        renderTable(currentReminders);
        renderPagination(data.total_pages || 1);
    } catch (err) {
        console.error('Error fetching reminders:', err);
    }
}

async function fetchTodaysReminders() {
    try {
        const response = await fetch(`${API_BASE}/todays-reminders`, {
            headers: { 'X-User-Email': currentUser || '' }
        });
        const data = await response.json();
        renderTodaysTable(data);
    } catch (err) {
        console.error('Error fetching todays reminders:', err);
    }
}

async function fetchTeamMembers() {
    try {
        const res = await fetch(`${API_BASE}/team-members`, {
            headers: { 'X-User-Email': currentUser || '' }
        });
        _teamMembers = await res.json();
    } catch (e) {
        console.error('Failed to fetch team members', e);
    }
}

function renderTable(reminders) {
    const tbody = document.getElementById('ib-table-body');
    if (!reminders || reminders.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#71717a;">No contracts found.</td></tr>';
        return;
    }
    tbody.innerHTML = reminders.map(r => `
        <tr onclick="window.open('http://localhost:5000/contract.html?id=${r.id}','_blank')" style="cursor:pointer;" title="Click to open contract page">
            <td data-label="IB ID">${r.ib_id}</td>
            <td data-label="Name">${r.name || '—'}</td>
            <td data-label="Start Date">${r.start_date}</td>
            <td data-label="End Date">${r.end_date}</td>
            <td data-label="Contract" onclick="event.stopPropagation()">
                ${r.contract_path ? `<a href="http://localhost:5000/${r.contract_path}" target="_blank" style="color: var(--primary);">View</a>` : 'None'}
            </td>
            <td data-label="Reminder Date">${r.reminder_date}</td>
            <td data-label="Status">
                <span style="color: ${r.is_sent ? '#22c55e' : '#f59e0b'}">
                    <i class="fa ${r.is_sent ? 'fa-check-circle' : 'fa-clock'}"></i> ${r.is_sent ? 'Sent' : 'Pending'}
                </span>
            </td>
            <td data-label="Created By">${r.created_by}</td>
            <td data-label="Actions" onclick="event.stopPropagation()">
                <div style="display:flex; gap:4px; align-items:center;">
                    <button onclick="editItem(${r.id})" title="Edit" style="width:28px;height:28px;border-radius:6px;border:none;background:#3b82f6;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:11px;"><i class="fa fa-pen"></i></button>
                    <button onclick="deleteItem(${r.id})" title="Delete" style="width:28px;height:28px;border-radius:6px;border:none;background:#ef4444;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:11px;"><i class="fa fa-trash"></i></button>
                    <button onclick="sendManual(${r.id})" title="Send Email" style="width:28px;height:28px;border-radius:6px;border:none;background:#8b5cf6;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:11px;"><i class="fa fa-paper-plane"></i></button>
                    <button onclick="window.open('http://localhost:5000/api/email-preview?id=${r.id}','_blank')" title="Preview Email" style="width:28px;height:28px;border-radius:6px;border:none;background:#0f766e;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:11px;"><i class="fa fa-eye"></i></button>
                </div>
            </td>
        </tr>
    `).join('');
}

function renderTodaysTable(reminders) {
    const tbody = document.getElementById('todays-table-body');
    if (reminders.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">No reminders for today.</td></tr>';
        return;
    }
    tbody.innerHTML = reminders.map(r => `
        <tr style="border-left: 4px solid var(--accent);">
            <td data-label="IB ID"><a href="http://localhost:5000/contract.html?id=${r.id}" target="_blank" style="color:#6366f1;text-decoration:none;font-weight:600;">${r.ib_id}</a></td>
            <td data-label="Reminder Date">${r.reminder_date}</td>
            <td data-label="Status">
                <span style="color: ${r.is_sent ? '#22c55e' : '#f59e0b'}">
                    <i class="fa ${r.is_sent ? 'fa-check-circle' : 'fa-clock'}"></i> ${r.is_sent ? 'Sent' : 'Today'}
                </span>
            </td>
            <td data-label="Text" style="max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${r.reminder_text}</td>
            <td data-label="Actions">
                <button class="btn" style="padding: 0.3rem 0.6rem; width: auto;" onclick="sendManual(${r.id})">Send Now</button>
            </td>
        </tr>
    `).join('');
}

function renderPagination(totalPages) {
    const container = document.getElementById('pagination');
    let html = '';
    for (let i = 1; i <= totalPages; i++) {
        html += `<button class="page-btn ${i === currentPage ? 'active' : ''}" onclick="fetchReminders(${i})">${i}</button>`;
    }
    container.innerHTML = html;
}

// Search with Debounce
let searchTimeout;
document.getElementById('search-input').addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
        fetchReminders(1);
    }, 500);
});

// ── Payment Calendar ────────────────────────────────────────
let _calYear = new Date().getFullYear();
let _calMonth = new Date().getMonth() + 1;
let _calSearchTimeout;

function debounceLoadCalendar() {
    clearTimeout(_calSearchTimeout);
    _calSearchTimeout = setTimeout(() => loadCalendar(), 500);
}

function prevCalMonth() {
    _calMonth--;
    if (_calMonth < 1) { _calMonth = 12; _calYear--; }
    loadCalendar();
}
function nextCalMonth() {
    _calMonth++;
    if (_calMonth > 12) { _calMonth = 1; _calYear++; }
    loadCalendar();
}

async function loadCalendar() {
    const monthNames = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    document.getElementById('cal-month-label').textContent = `${monthNames[_calMonth]} ${_calYear}`;

    const search = document.getElementById('cal-search').value.trim();
    const status = document.getElementById('cal-status').value;

    document.getElementById('payment-calendar-grid').innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:2rem;"><i class="fa fa-spinner fa-spin"></i> Loading...</div>';

    try {
        const res = await fetch(`${API_BASE}/payment-calendar?year=${_calYear}&month=${_calMonth}&search=${encodeURIComponent(search)}&status=${encodeURIComponent(status)}`, {
            headers: { 'X-User-Email': currentUser }
        });
        const data = await res.json();
        if (data.success) {
            renderPaymentCalendar(data.payments);
        }
    } catch (e) {
        document.getElementById('payment-calendar-grid').innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:2rem;color:#f87171;">Failed to load calendar</div>';
    }
}

function renderPaymentCalendar(payments) {
    const grid = document.getElementById('payment-calendar-grid');
    const firstDay = new Date(_calYear, _calMonth - 1, 1).getDay();
    const daysInMonth = new Date(_calYear, _calMonth, 0).getDate();
    const daysInPrevMonth = new Date(_calYear, _calMonth - 1, 0).getDate();

    // Header
    let html = `
        <div class="cal-header">Sun</div><div class="cal-header">Mon</div><div class="cal-header">Tue</div>
        <div class="cal-header">Wed</div><div class="cal-header">Thu</div><div class="cal-header">Fri</div><div class="cal-header">Sat</div>
    `;

    const todayStr = new Date().toISOString().slice(0, 10);
    const mStr = String(_calMonth).padStart(2, '0');

    let totalCells = Math.ceil((firstDay + daysInMonth) / 7) * 7;

    for (let i = 0; i < totalCells; i++) {
        let isToday = false;
        let dayClass = 'cal-day';
        let dayNum = '';
        let dateStr = '';

        if (i < firstDay) {
            dayClass += ' other-month';
            dayNum = daysInPrevMonth - firstDay + 1 + i;
        } else if (i >= firstDay && i < firstDay + daysInMonth) {
            dayNum = i - firstDay + 1;
            const dStr = String(dayNum).padStart(2, '0');
            dateStr = `${_calYear}-${mStr}-${dStr}`;
            if (dateStr === todayStr) dayClass += ' today';
        } else {
            dayClass += ' other-month';
            dayNum = i - (firstDay + daysInMonth) + 1;
        }

        let dayPaymentsHtml = '';
        if (dateStr) {
            let dayPayments = payments.filter(p => p.date === dateStr);
            dayPayments.forEach(p => {
                let statusClass = p.status.replace(/ /g, '-');
                dayPaymentsHtml += `
                    <div class="cal-payment cal-pay-status-${statusClass}" onclick="window.open('http://localhost:5000/contract.html?id=${p.contract_id}', '_blank')" title="${p.name} - ${p.status}">
                        <strong>${p.ib_id}</strong>: $${Number(p.amount || 0).toLocaleString()}
                    </div>
                `;
            });
        }

        html += `
            <div class="${dayClass}">
                <div class="cal-date">${dayNum}</div>
                ${dayPaymentsHtml}
            </div>
        `;
    }

    grid.innerHTML = html;
}

// ── Report ────────────────────────────────────────────────────
let _reportData = null;
let _acIbIds = [];   // valid IB IDs from DB
let _acIbNames = [];   // valid IB Names from DB

async function openReportModal() {
    document.getElementById('report-modal').style.display = 'flex';
    // Restore previous report if available
    if (_reportData) {
        renderReportBody(_reportData);
        document.getElementById('report-generated-at').textContent =
            '— Generated ' + _reportData.generated_at;
    }

    // Populate Assignees
    const assigneeSel = document.getElementById('report-assignee');
    if (assigneeSel) {
        assigneeSel.innerHTML = '<option value="">All Assignees</option>' +
            _teamMembers.map(m => `<option value="${m.email}">${m.email}</option>`).join('');
    }

    // Always refresh autocomplete meta
    try {
        const res = await fetch(`${API_BASE}/report/meta`, {
            headers: { 'X-User-Email': currentUser }
        });
        const meta = await res.json();
        _acIbIds = meta.ib_ids || [];
        _acIbNames = meta.ib_names || [];
    } catch (e) { }
}
function closeReportModal() {
    document.getElementById('report-modal').style.display = 'none';
}

// ── Autocomplete helpers ──────────────────────────────────────
// Wrappers called from HTML — arrays evaluated fresh at call time
function filterAcById() { filterAC('ac-ib-id', 'report-ib-id', _acIbIds); }
function filterAcByName() { filterAC('ac-ib-name', 'report-ib-name', _acIbNames); }

function filterAC(listId, inputId, items) {
    const q = document.getElementById(inputId).value.trim().toLowerCase();
    const list = document.getElementById(listId);

    if (!items || items.length === 0) {
        list.innerHTML = `<div class="ac-item ac-no-match">Loading...</div>`;
        list.style.display = 'block';
        return;
    }

    const hits = q ? items.filter(v => String(v).toLowerCase().includes(q)) : items;
    if (hits.length === 0) {
        list.innerHTML = `<div class="ac-item ac-no-match">No matching results</div>`;
    } else {
        list.innerHTML = hits.slice(0, 25).map(v => {
            const safe = String(v).replace(/'/g, "\\'");
            const highlighted = q
                ? String(v).replace(new RegExp(`(${q})`, 'gi'), '<strong style="color:#6366f1;">$1</strong>')
                : String(v);
            return `<div class="ac-item" onmousedown="selectAC('${listId}','${inputId}','${safe}')">${highlighted}</div>`;
        }).join('');
    }
    list.style.display = 'block';
}
function hideAC(listId) {
    const el = document.getElementById(listId);
    if (el) el.style.display = 'none';
}
function selectAC(listId, inputId, value) {
    document.getElementById(inputId).value = value;
    hideAC(listId);
}

function resetReportFilters() {
    ['report-from', 'report-to', 'report-ib-id', 'report-ib-name'].forEach(id => {
        document.getElementById(id).value = '';
    });
    document.getElementById('report-pay-status').value = '';
    document.getElementById('report-target-type').value = '';
    if (document.getElementById('report-assignee')) {
        document.getElementById('report-assignee').value = '';
    }
}

async function loadReport() {
    const params = new URLSearchParams();
    const from = document.getElementById('report-from').value;
    const to = document.getElementById('report-to').value;
    const ibId = document.getElementById('report-ib-id').value.trim();
    const ibName = document.getElementById('report-ib-name').value.trim();
    const payStatus = document.getElementById('report-pay-status').value;
    const targetType = document.getElementById('report-target-type').value;
    const assignee = document.getElementById('report-assignee') ? document.getElementById('report-assignee').value : '';

    if (from) params.set('date_from', from);
    if (to) params.set('date_to', to);
    if (ibId) params.set('ib_id', ibId);
    if (ibName) params.set('ib_name', ibName);
    if (payStatus) params.set('payment_status', payStatus);
    if (targetType) params.set('target_type', targetType);
    if (assignee) params.set('assignee', assignee);

    // Validate autocomplete fields — must be in the known list if not empty
    if (ibId && _acIbIds.length > 0 && !_acIbIds.includes(ibId)) {
        showToast('⚠️ IB ID not found. Please select a valid IB ID.', 'error');
        return;
    }
    if (ibName && _acIbNames.length > 0 && !_acIbNames.some(n => n.toLowerCase() === ibName.toLowerCase())) {
        showToast('⚠️ IB Name not found. Please select a valid name from suggestions.', 'error');
        return;
    }

    document.getElementById('report-body').innerHTML =
        `<div style="text-align:center;padding:3rem;color:#71717a;"><i class="fa fa-spinner fa-spin" style="font-size:2rem;"></i><br>Loading...</div>`;

    try {
        const res = await fetch(`${API_BASE}/report?${params}`, {
            headers: { 'X-User-Email': currentUser }
        });
        _reportData = await res.json();
        document.getElementById('report-generated-at').textContent =
            '— Generated ' + _reportData.generated_at;
        renderReportBody(_reportData);
    } catch (e) {
        document.getElementById('report-body').innerHTML =
            `<div style="color:#f87171;padding:2rem;">Failed to load report.</div>`;
    }
}

function renderReportBody(d) {
    const s = d.summary;
    const contracts = d.contracts;
    const fmt = n => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });

    // ── KPI Bar (compact single row) ──
    const kpis = [
        { label: 'Contracts', value: s.total_contracts, icon: 'fa-file-contract', color: '#3b82f6' },
        { label: 'Active', value: s.active, icon: 'fa-circle-check', color: '#4ade80' },
        { label: 'Expired', value: s.expired, icon: 'fa-circle-xmark', color: '#f87171' },
        { label: 'Expected', value: fmt(s.total_expected), icon: 'fa-money-bill-wave', color: '#a78bfa' },
        { label: 'Paid', value: fmt(s.total_paid), icon: 'fa-circle-dollar-to-slot', color: '#4ade80' },
        { label: 'Approval Pending', value: s.payments_pending, icon: 'fa-clock', color: '#fbbf24' },
        { label: 'Payment Pending', value: s.payments_done, icon: 'fa-hourglass-half', color: '#60a5fa' },
        { label: 'Rejected', value: s.payments_canceled, icon: 'fa-ban', color: '#f87171' },
    ];

    const kpiHtml = `
    <div style="display:flex;flex-wrap:nowrap;overflow-x:auto;gap:0;margin-bottom:1.25rem;background:#111113;border:1px solid #27272a;border-radius:0.75rem;padding:0.6rem 0.75rem;align-items:center;">
        ${kpis.map((k, i) => `
        ${i > 0 ? '<div style="width:1px;height:24px;background:#27272a;flex-shrink:0;margin:0 4px;"></div>' : ''}
        <div style="display:flex;align-items:center;gap:0.4rem;padding:0 0.5rem;white-space:nowrap;">
            <i class="fa ${k.icon}" style="color:${k.color};font-size:0.85rem;"></i>
            <span style="font-weight:700;font-size:0.95rem;color:#f4f4f5;">${k.value}</span>
            <span style="font-size:0.7rem;color:#71717a;font-weight:500;">${k.label}</span>
        </div>`).join('')}
    </div>`;


    // ── Contracts Table ──
    const contractsHtml = `
    <div>
        <div style="font-size:0.8rem;font-weight:700;color:#4ade80;text-transform:uppercase;letter-spacing:1px;margin-bottom:0.75rem;">
            <i class="fa fa-table"></i> Contract Detail (${contracts.length})
        </div>
        <div style="overflow-x:auto;">
        <table id="rpt-contracts-table" style="width:100%;border-collapse:collapse;font-size:0.82rem;">
            <thead><tr style="background:#052e16;">
                <th style="padding:10px 12px;text-align:left;color:#4ade80;white-space:nowrap;">IB ID</th>
                <th style="padding:10px 12px;text-align:left;color:#4ade80;white-space:nowrap;">Name</th>
                <th style="padding:10px 12px;text-align:left;color:#4ade80;white-space:nowrap;">Start</th>
                <th style="padding:10px 12px;text-align:left;color:#4ade80;white-space:nowrap;">End</th>
                <th style="padding:10px 12px;text-align:left;color:#4ade80;white-space:nowrap;">Status</th>
                <th style="padding:10px 12px;text-align:left;color:#4ade80;white-space:nowrap;">Targets</th>
                <th style="padding:10px 12px;text-align:right;color:#4ade80;white-space:nowrap;">Expected</th>
                <th style="padding:10px 12px;text-align:right;color:#4ade80;white-space:nowrap;">Paid</th>
                <th style="padding:10px 12px;text-align:right;color:#4ade80;white-space:nowrap;">Done</th>
                <th style="padding:10px 12px;text-align:left;color:#4ade80;white-space:nowrap;">Created By</th>
            </tr></thead>
            <tbody>
            ${contracts.map((c, i) => {
        const statusBg = c.active ? '#052e16' : '#1c1917';
        const statusClr = c.active ? '#4ade80' : '#78716c';
        return `<tr style="border-top:1px solid #27272a;background:${i % 2 === 0 ? 'transparent' : '#0a0a0a'};">
                    <td style="padding:8px 12px;">
                        <span onclick="openContractDetailFromReport(${c.id})"
                            style="color:#6366f1;font-weight:700;cursor:pointer;text-decoration:underline;text-underline-offset:2px;"
                            title="View contract details">${c.ib_id}</span>
                    </td>
                    <td style="padding:8px 12px;">
                        <span onclick="openContractDetailFromReport(${c.id})"
                            style="color:#d4d4d8;cursor:pointer;"
                            onmouseover="this.style.color='#a5b4fc'" onmouseout="this.style.color='#d4d4d8'"
                            title="View contract details">${c.name || '—'}</span>
                    </td>
                    <td style="padding:8px 12px;color:#71717a;white-space:nowrap;">${c.start_date}</td>
                    <td style="padding:8px 12px;color:#71717a;white-space:nowrap;">${c.end_date}</td>
                    <td style="padding:8px 12px;"><span style="background:${statusBg};color:${statusClr};border-radius:999px;padding:2px 8px;font-size:0.72rem;font-weight:700;">${c.active ? 'Active' : 'Expired'}</span></td>
                    <td style="padding:8px 12px;color:#a5b4fc;font-size:0.75rem;">${c.targets.join(', ') || '—'}</td>
                    <td style="padding:8px 12px;text-align:right;color:#a5b4fc;">${fmt(c.total_expected)}</td>
                    <td style="padding:8px 12px;text-align:right;color:#4ade80;font-weight:700;">${fmt(c.total_paid)}</td>
                    <td style="padding:8px 12px;text-align:right;color:#4ade80;">${c.payments_done}</td>
                    <td style="padding:8px 12px;color:#71717a;font-size:0.78rem;">${c.created_by}</td>
                </tr>`;
    }).join('')}
            </tbody>
        </table></div>
    </div>`;

    document.getElementById('report-body').innerHTML = kpiHtml + contractsHtml;
}

function openContractDetailFromReport(contractId) {
    window.open('http://localhost:5000/contract.html?id=' + contractId, '_blank');
}


// ── Export Excel ──────────────────────────────────────────────
function exportReportExcel() {
    if (!_reportData) { showToast('⚠️ Generate the report first.', 'error'); return; }
    const d = _reportData;
    const wb = XLSX.utils.book_new();

    // Sheet 1: Summary
    const summaryData = [
        ['Metric', 'Value'],
        ['Generated At', d.generated_at],
        ['Total Contracts', d.summary.total_contracts],
        ['Active', d.summary.active],
        ['Expired', d.summary.expired],
        ['Total Expected', d.summary.total_expected],
        ['Total Paid', d.summary.total_paid],
        ['Payments Pending', d.summary.payments_pending],
        ['Payments Done', d.summary.payments_done],
        ['Payments Canceled', d.summary.payments_canceled],
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryData), 'Summary');

    // Sheet 2: Target Breakdown
    const tgtRows = [['Target', 'Count', 'Expected', 'Paid']];
    const TL = { net_deposit: 'Net Deposit', ftd: 'FTD', deposit: 'Deposit', pr: 'PR', marketing: 'Marketing' };
    Object.entries(d.summary.by_target).forEach(([k, v]) => {
        tgtRows.push([TL[k] || k, v.count, v.expected, v.paid]);
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(tgtRows), 'By Target');

    // Sheet 3: Contracts
    const headers = ['IB ID', 'Name', 'Start Date', 'End Date', 'Status',
        'Targets', 'Expected', 'Paid', 'Total Pmts', 'Done', 'Pending', 'Created By'];
    const rows = d.contracts.map(c => [
        c.ib_id, c.name, c.start_date, c.end_date,
        c.active ? 'Active' : 'Expired',
        c.targets.join(', '),
        c.total_expected, c.total_paid,
        c.payments_count, c.payments_done, c.payments_pending,
        c.created_by
    ]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers, ...rows]), 'Contracts');

    // Sheet 4: Payment Details
    const pmtHeaders = ['Contract IB ID', 'Contract Name', 'Date', 'Amount', 'Target', 'Status', 'Paid Amount', 'Hash/Link', 'Comment'];
    const pmtRows = [];
    d.contracts.forEach(c => {
        (c.payments || []).forEach(p => {
            const TK = { net_deposit: 'Net Deposit', ftd: 'FTD', deposit: 'Deposit', pr: 'PR', marketing: 'Marketing' };
            pmtRows.push([c.ib_id, c.name, p.date, p.amount,
            TK[p.target_key] || p.target_key, p.status || 'Pending',
            p.paid_amount || '', p.hash_link || '', p.comment || '']);
        });
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([pmtHeaders, ...pmtRows]), 'Payment Details');

    XLSX.writeFile(wb, `IB_Contracts_Report_${d.generated_at.replace(/[: ]/g, '_')}.xlsx`);
    showToast('✅ Excel exported successfully.', 'success');
}

// ── Export PDF ────────────────────────────────────────────────
function exportReportPDF() {
    if (!_reportData) { showToast('⚠️ Generate the report first.', 'error'); return; }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    const d = _reportData;
    const s = d.summary;
    const fmt = n => Number(n || 0).toLocaleString();

    // Title
    doc.setFontSize(16); doc.setTextColor(59, 130, 246);
    doc.text('IB Contracts Report', 40, 40);
    doc.setFontSize(9); doc.setTextColor(113, 113, 122);
    doc.text(`Generated: ${d.generated_at}`, 40, 56);

    // Summary row
    doc.setFontSize(10); doc.setTextColor(228, 228, 231);
    const ks = [
        `Total: ${s.total_contracts}`, `Active: ${s.active}`, `Expired: ${s.expired}`,
        `Expected: ${fmt(s.total_expected)}`, `Paid: ${fmt(s.total_paid)}`,
        `Pending: ${s.payments_pending}`, `Done: ${s.payments_done}`, `Canceled: ${s.payments_canceled}`
    ];
    ks.forEach((k, i) => doc.text(k, 40 + (i * 100), 72));

    // Target table
    doc.autoTable({
        startY: 90,
        head: [['Target', '# Payments', 'Expected', 'Paid']],
        body: Object.entries(s.by_target).map(([k, v]) => {
            const TL = { net_deposit: 'Net Deposit', ftd: 'FTD', deposit: 'Deposit', pr: 'PR', marketing: 'Marketing' };
            return [TL[k] || k, v.count, fmt(v.expected), fmt(v.paid)];
        }),
        styles: { fillColor: [24, 24, 27], textColor: [228, 228, 231], lineColor: [39, 39, 42] },
        headStyles: { fillColor: [30, 27, 75], textColor: [165, 180, 252] },
        margin: { left: 40, right: 40 },
        tableWidth: 'auto',
    });

    // Contracts table
    const startY = doc.lastAutoTable.finalY + 20;
    doc.setFontSize(11); doc.setTextColor(74, 222, 128);
    doc.text('Contract Details', 40, startY);

    doc.autoTable({
        startY: startY + 12,
        head: [['IB ID', 'Name', 'Start', 'End', 'Status', 'Expected', 'Paid', 'Done/Total']],
        body: d.contracts.map(c => [
            c.ib_id, c.name || '—', c.start_date, c.end_date,
            c.active ? 'Active' : 'Expired',
            fmt(c.total_expected), fmt(c.total_paid),
            `${c.payments_done}/${c.payments_count}`
        ]),
        styles: { fillColor: [24, 24, 27], textColor: [228, 228, 231], lineColor: [39, 39, 42], fontSize: 8 },
        headStyles: { fillColor: [5, 46, 22], textColor: [74, 222, 128] },
        alternateRowStyles: { fillColor: [10, 10, 10] },
        margin: { left: 40, right: 40 },
    });

    doc.save(`IB_Contracts_Report_${d.generated_at.replace(/[: ]/g, '_')}.pdf`);
    showToast('✅ PDF exported successfully.', 'success');
}

// ── Targets & Payments State ──────────────────────────────────
const TARGET_KEYS = [
    { key: 'net_deposit', label: 'Net Deposit' },
    { key: 'ftd', label: 'FTD' },
    { key: 'deposit', label: 'Deposit' },
    { key: 'pr', label: 'PR' },
    { key: 'marketing', label: 'Marketing' },
];
let _targets = {};   // { net_deposit: {enabled, detail}, ... }
let _payments = [];   // [{date, amount, target_key}]

// ── Target Modal ──────────────────────────────────────────────
function openTargetModal() {
    document.getElementById('target-rows').innerHTML = TARGET_KEYS.map(t => {
        const s = _targets[t.key] || { enabled: false, detail: '' };
        return `
        <div style="background:#18181b;border:1px solid #27272a;border-radius:0.5rem;padding:0.75rem;">
            <div style="display:flex;align-items:center;gap:0.75rem;">
                <input type="checkbox" id="tgt-${t.key}" ${s.enabled ? 'checked' : ''}
                    onchange="document.getElementById('tgt-detail-${t.key}').style.display=this.checked?'block':'none'"
                    style="width:18px;height:18px;accent-color:#6366f1;cursor:pointer;flex-shrink:0;">
                <label for="tgt-${t.key}" style="color:#e4e4e7;font-weight:600;cursor:pointer;">${t.label}</label>
            </div>
            <div id="tgt-detail-${t.key}" style="margin-top:0.5rem;display:${s.enabled ? 'block' : 'none'}">
                <textarea id="tgt-text-${t.key}" placeholder="Details for ${t.label}..."
                    style="width:100%;min-height:70px;background:#27272a;border:1px solid #3f3f46;border-radius:0.4rem;color:white;padding:0.5rem 0.75rem;font-size:0.85rem;resize:vertical;font-family:inherit;margin-bottom:0.5rem;"
                >${(s.detail || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>
                <div style="display:flex;align-items:center;gap:0.5rem;background:#1e1b4b;padding:0.5rem;border-radius:0.4rem;border:1px solid #3730a3;">
                    <i class="fa fa-user-circle" style="color:#818cf8;"></i>
                    <select id="tgt-assignee-${t.key}" style="flex:1;background:transparent;border:none;color:white;font-size:0.85rem;outline:none;cursor:pointer;">
                        <option value="" style="color:black;">--- Assign Team Member ---</option>
                        ${_teamMembers.map(m => `<option value="${m.email}" style="color:black;" ${s.assignee === m.email ? 'selected' : ''}>${m.email}</option>`).join('')}
                    </select>
                </div>
            </div>
        </div>`;
    }).join('');
    document.getElementById('target-modal').style.display = 'flex';
}
function closeTargetModal() {
    document.getElementById('target-modal').style.display = 'none';
}
function saveTargets() {
    TARGET_KEYS.forEach(t => {
        const enabled = document.getElementById(`tgt-${t.key}`).checked;
        const detail = document.getElementById(`tgt-text-${t.key}`)?.value || '';
        const assignee = document.getElementById(`tgt-assignee-${t.key}`)?.value || '';
        _targets[t.key] = { enabled, detail, assignee };
    });
    const count = TARGET_KEYS.filter(t => _targets[t.key]?.enabled).length;
    const badge = document.getElementById('target-badge');
    badge.textContent = count;
    badge.style.display = count > 0 ? 'inline' : 'none';
    closeTargetModal();
    showToast(`✅ ${count} target(s) set.`, 'success');
}

// ── Payments Modal ────────────────────────────────────────────
function openPaymentsModal() {
    const active = TARGET_KEYS.filter(t => _targets[t.key]?.enabled);
    if (active.length === 0) {
        showToast('⚠️ Please set at least one target before adding payments.', 'error');
        return;
    }
    renderPaymentRows();
    document.getElementById('payments-modal').style.display = 'flex';
}
function closePaymentsModal() {
    document.getElementById('payments-modal').style.display = 'none';
}
function renderPaymentRows() {
    const active = TARGET_KEYS.filter(t => _targets[t.key]?.enabled);
    const container = document.getElementById('payment-rows');
    const empty = document.getElementById('payment-empty');
    if (_payments.length === 0) {
        container.innerHTML = '';
        empty.style.display = 'block';
        return;
    }
    empty.style.display = 'none';
    container.innerHTML = _payments.map((p, i) => `
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:0.5rem;align-items:center;background:#18181b;border:1px solid #27272a;border-radius:0.5rem;padding:0.55rem 0.75rem;">
            <input type="date" value="${p.date}" onchange="_payments[${i}].date=this.value"
                style="background:#27272a;border:1px solid #3f3f46;border-radius:0.4rem;color:white;padding:0.4rem 0.6rem;font-size:0.82rem;">
            <input type="number" value="${p.amount}" placeholder="Amount" onchange="_payments[${i}].amount=this.value"
                style="background:#27272a;border:1px solid #3f3f46;border-radius:0.4rem;color:white;padding:0.4rem 0.6rem;font-size:0.82rem;">
            <select onchange="_payments[${i}].target_key=this.value"
                style="background:#27272a;border:1px solid #3f3f46;border-radius:0.4rem;color:white;padding:0.4rem 0.6rem;font-size:0.82rem;">
                ${active.map(t => `<option value="${t.key}" ${p.target_key === t.key ? 'selected' : ''}>${t.label}</option>`).join('')}
            </select>
            <button onclick="removePayment(${i})"
                style="width:28px;height:28px;border-radius:6px;border:none;background:#ef4444;color:#fff;cursor:pointer;font-size:11px;">
                <i class="fa fa-trash"></i>
            </button>
        </div>`).join('');
}
function addPaymentRow() {
    const active = TARGET_KEYS.filter(t => _targets[t.key]?.enabled);
    if (!active.length) return;
    _payments.push({ date: '', amount: '', target_key: active[0].key });
    renderPaymentRows();
}
function removePayment(i) {
    _payments.splice(i, 1);
    renderPaymentRows();
}
function savePayments() {
    const badge = document.getElementById('payments-badge');
    badge.textContent = _payments.length;
    badge.style.display = _payments.length > 0 ? 'inline' : 'none';
    closePaymentsModal();
    showToast(`✅ ${_payments.length} payment(s) set.`, 'success');
}

// ── Contract Detail Modal (row click) ────────────────────────
function showContractDetail(id) {
    const r = currentReminders.find(x => x.id === id);
    if (!r) return;
    let targets = {}, payments = [];
    try { targets = JSON.parse(r.targets || '{}'); } catch (e) { }
    try { payments = JSON.parse(r.payments || '[]'); } catch (e) { }

    const activeTargets = TARGET_KEYS.filter(t => targets[t.key]?.enabled);
    const targetsHtml = activeTargets.length > 0
        ? activeTargets.map(t => `
            <div style="background:#1e1b4b;border:1px solid #3730a3;border-radius:0.5rem;padding:0.5rem 0.85rem;margin-bottom:0.4rem;">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;">
                    <span style="color:#a5b4fc;font-weight:700;">${t.label}</span>
                    ${targets[t.key].assignee ? `<span style="background:#3730a3;color:white;font-size:0.7rem;padding:0.15rem 0.4rem;border-radius:0.25rem;"><i class="fa fa-user"></i> ${targets[t.key].assignee}</span>` : ''}
                </div>
                ${targets[t.key].detail ? `<div style="color:#d4d4d8;margin-top:0.4rem;font-size:0.85rem;white-space:pre-wrap;border-top:1px dashed #4338ca;padding-top:0.4rem;">${targets[t.key].detail}</div>` : ''}
            </div>`).join('')
        : '<span style="color:#52525b;">No targets set.</span>';

    const targetLabelMap = Object.fromEntries(TARGET_KEYS.map(t => [t.key, t.label]));
    const canEditPayments = (currentRole === 'Admin' || currentRole === 'Backoffice');

    const statusBadge = (p) => {
        const st = p.status || 'Approval Pending';
        const cfg = {
            'Approval Pending': { bg: '#78350f', color: '#fbbf24', icon: 'fa-clock' },
            'Payment Pending': { bg: '#1e3a5f', color: '#60a5fa', icon: 'fa-hourglass-half' },
            'Paid': { bg: '#14532d', color: '#4ade80', icon: 'fa-check-circle' },
            'Rejected': { bg: '#450a0a', color: '#f87171', icon: 'fa-times-circle' },
        };
        const c = cfg[st] || cfg['Approval Pending'];
        return `<span style="background:${c.bg};color:${c.color};border-radius:999px;padding:2px 9px;font-size:0.73rem;font-weight:700;white-space:nowrap;"><i class="fa ${c.icon}"></i> ${st}</span>`;
    };

    const paymentsHtml = payments.length > 0
        ? `<table style="width:100%;border-collapse:collapse;font-size:0.85rem;">
            <thead><tr style="background:#27272a;">
                <th style="padding:8px 12px;text-align:left;color:#71717a;">Date</th>
                <th style="padding:8px 12px;text-align:left;color:#71717a;">Amount</th>
                <th style="padding:8px 12px;text-align:left;color:#71717a;">Target</th>
                <th style="padding:8px 12px;text-align:left;color:#71717a;">Status</th>
                ${canEditPayments ? '<th style="padding:8px 12px;text-align:left;color:#71717a;">Paid</th>' : ''}
            </tr></thead>
            <tbody>${payments.map((p, i) => `
                <tr onclick="openPaymentDetailModal(${r.id},${i})"
                    style="border-top:1px solid #27272a;cursor:pointer;transition:background 0.15s;"
                    onmouseover="this.style.background='#1f1f23'" onmouseout="this.style.background=''">
                    <td style="padding:8px 12px;color:#e4e4e7;">${p.date}</td>
                    <td style="padding:8px 12px;color:#4ade80;font-weight:600;">${Number(p.amount || 0).toLocaleString()}</td>
                    <td style="padding:8px 12px;color:#a5b4fc;">${targetLabelMap[p.target_key] || p.target_key}</td>
                    <td style="padding:8px 12px;">${statusBadge(p)}</td>
                    ${canEditPayments ? `<td style="padding:8px 12px;color:#d4d4d8;">${p.paid_amount ? Number(p.paid_amount).toLocaleString() : '—'}</td>` : ''}
                </tr>`).join('')}
            </tbody></table>`
        : '<span style="color:#52525b;">No payments set.</span>';

    document.getElementById('contract-detail-body').innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;margin-bottom:1.25rem;">
            ${[['IB ID', r.ib_id], ['Name', r.name || '—'], ['Start Date', r.start_date], ['End Date', r.end_date],
        ['Reminder Date', r.reminder_date], ['Created By', r.created_by]].map(([l, v]) =>
            `<div style="background:#18181b;border:1px solid #27272a;border-radius:0.5rem;padding:0.65rem 1rem;">
                    <div style="color:#71717a;font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:1px;margin-bottom:0.3rem;">${l}</div>
                    <div style="color:#f4f4f5;font-weight:500;">${v}</div>
                </div>`).join('')}
        </div>
        ${r.contract_path ? `<div style="margin-bottom:1rem;"><a href="http://localhost:5000/${r.contract_path}" target="_blank" style="color:#6366f1;"><i class="fa fa-file"></i> View Contract File</a></div>` : ''}
        ${r.reminder_text ? `<div style="background:#18181b;border:1px solid #27272a;border-radius:0.5rem;padding:1rem;margin-bottom:1.25rem;"><div style="color:#71717a;font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:1px;margin-bottom:0.5rem;">Reminder Note</div><div style="color:#d4d4d8;line-height:1.7;white-space:pre-wrap;">${r.reminder_text}</div></div>` : ''}
        <div style="margin-bottom:1rem;"><div style="color:#a5b4fc;font-size:0.8rem;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:0.6rem;"><i class="fa fa-bullseye"></i> Targets</div>${targetsHtml}</div>
        <div><div style="color:#4ade80;font-size:0.8rem;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:0.6rem;"><i class="fa fa-money-bill-wave"></i> Payments ${payments.length > 0 ? '<span style="color:#71717a;font-size:0.72rem;font-weight:400;margin-left:0.5rem;">(click row for details)</span>' : ''}</div>${paymentsHtml}</div>
    `;
    document.getElementById('contract-detail-modal').style.display = 'flex';
}

// ── Payment Detail Modal ──────────────────────────────────────
let _pdContractId = null;
let _pdPayIndex = null;

function openPaymentDetailModal(contractId, payIdx) {
    const r = currentReminders.find(x => x.id === contractId);
    if (!r) return;
    let payments = [];
    try { payments = JSON.parse(r.payments || '[]'); } catch (e) { }
    const p = payments[payIdx];
    if (!p) return;

    _pdContractId = contractId;
    _pdPayIndex = payIdx;

    const targetLabelMap = Object.fromEntries(TARGET_KEYS.map(t => [t.key, t.label]));
    document.getElementById('pd-meta').innerHTML =
        `<i class="fa fa-calendar"></i> <strong>${p.date}</strong> &nbsp;|&nbsp;
         <i class="fa fa-bullseye"></i> ${targetLabelMap[p.target_key] || p.target_key} &nbsp;|&nbsp;
         Expected: <strong style="color:#4ade80;">${Number(p.amount || 0).toLocaleString()}</strong>`;

    const status = p.status || 'Approval Pending';

    // Show current status badge
    const stCfg = {
        'Approval Pending': { bg: '#78350f', color: '#fbbf24', icon: 'fa-clock' },
        'Payment Pending': { bg: '#1e3a5f', color: '#60a5fa', icon: 'fa-hourglass-half' },
        'Paid': { bg: '#14532d', color: '#4ade80', icon: 'fa-check-circle' },
        'Rejected': { bg: '#450a0a', color: '#f87171', icon: 'fa-times-circle' },
    };
    const sc = stCfg[status] || stCfg['Approval Pending'];
    document.getElementById('pd-current-status').innerHTML =
        `<span style="background:${sc.bg};color:${sc.color};border-radius:999px;padding:4px 14px;font-size:0.82rem;font-weight:700;">
            <i class="fa ${sc.icon}"></i> Current: ${status}
        </span>`;

    // Set radio buttons
    document.getElementById('pd-status-approved').checked = (status === 'Payment Pending' || status === 'Paid');
    document.getElementById('pd-status-rejected').checked = (status === 'Rejected');

    // Comment
    document.getElementById('pd-comment').value = p.comment || '';

    // Payment section
    document.getElementById('pd-paid-amount').value = p.paid_amount || '';
    document.getElementById('pd-hash-link').value = p.hash_link || '';
    document.getElementById('pd-payment-done').checked = (status === 'Paid');

    const canEdit = (currentRole === 'Admin' || currentRole === 'Backoffice');
    document.getElementById('pd-readonly-notice').style.display = canEdit ? 'none' : 'block';
    document.getElementById('pd-save-btn').style.display = canEdit ? 'block' : 'none';
    ['pd-paid-amount', 'pd-hash-link', 'pd-comment'].forEach(id =>
        document.getElementById(id).disabled = !canEdit);
    document.querySelectorAll('input[name="pd-status"]').forEach(inp => inp.disabled = !canEdit);
    document.getElementById('pd-payment-done').disabled = !canEdit;

    updatePdStatusStyle();

    document.getElementById('payment-detail-modal').style.display = 'flex';
}

function closePaymentDetailModal() {
    document.getElementById('payment-detail-modal').style.display = 'none';
    _pdContractId = null; _pdPayIndex = null;
}

function updatePdStatusStyle() {
    const approved = document.getElementById('pd-status-approved').checked;
    const rejected = document.getElementById('pd-status-rejected').checked;
    document.getElementById('pd-status-approved-label').style.borderColor = approved ? '#22c55e' : '#27272a';
    document.getElementById('pd-status-rejected-label').style.borderColor = rejected ? '#ef4444' : '#27272a';

    // Show/hide pay section based on approval
    document.getElementById('pd-pay-section').style.display = approved ? 'block' : 'none';
}

async function savePaymentDetail() {
    const approved = document.getElementById('pd-status-approved').checked;
    const rejected = document.getElementById('pd-status-rejected').checked;
    const paymentDone = document.getElementById('pd-payment-done').checked;

    let status = 'Approval Pending';
    if (rejected) status = 'Rejected';
    else if (approved && paymentDone) status = 'Paid';
    else if (approved) status = 'Payment Pending';

    const paid_amount = document.getElementById('pd-paid-amount').value;
    const hash_link = document.getElementById('pd-hash-link').value;
    const comment = document.getElementById('pd-comment').value;

    const res = await fetch(`${API_BASE}/ib-reminders/${_pdContractId}/payment/${_pdPayIndex}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-User-Email': currentUser },
        body: JSON.stringify({ status, paid_amount, hash_link, comment })
    });
    const data = await res.json();
    if (data.success) {
        const r = currentReminders.find(x => x.id === _pdContractId);
        if (r) r.payments = JSON.stringify(data.payments);
        closePaymentDetailModal();
        showToast('✅ Payment updated successfully.', 'success');
        showContractDetail(_pdContractId);
    } else {
        showToast('❌ ' + (data.message || 'Failed to update payment.'), 'error');
    }
}


// Modal Logic
function openModal() {
    document.getElementById('modal-title').innerText = "Add IB Contract";
    document.getElementById('edit_id').value = "";
    document.getElementById('add-form').reset();
    _targets = {}; _payments = [];
    document.getElementById('target-badge').style.display = 'none';
    document.getElementById('payments-badge').style.display = 'none';
    document.getElementById('add-modal').style.display = 'flex';
}

function closeModal() {
    document.getElementById('add-modal').style.display = 'none';
}

function editItem(id) {
    const item = currentReminders.find(r => r.id === id);
    if (!item) return;

    document.getElementById('modal-title').innerText = "Edit IB Contract";
    document.getElementById('edit_id').value = item.id;
    document.getElementById('ib_id').value = item.ib_id;
    document.getElementById('contract_name').value = item.name || '';
    document.getElementById('start_date').value = item.start_date;
    document.getElementById('end_date').value = item.end_date;
    document.getElementById('reminder_date').value = item.reminder_date;
    document.getElementById('reminder_text').value = item.reminder_text;

    try { _targets = JSON.parse(item.targets || '{}'); } catch (e) { _targets = {}; }
    try { _payments = JSON.parse(item.payments || '[]'); } catch (e) { _payments = []; }

    const tc = TARGET_KEYS.filter(t => _targets[t.key]?.enabled).length;
    const b1 = document.getElementById('target-badge');
    b1.textContent = tc; b1.style.display = tc > 0 ? 'inline' : 'none';
    const b2 = document.getElementById('payments-badge');
    b2.textContent = _payments.length; b2.style.display = _payments.length > 0 ? 'inline' : 'none';

    document.getElementById('add-modal').style.display = 'flex';
}

async function deleteItem(id) {
    if (!confirm('Are you sure you want to delete this IB reminder?')) return;
    try {
        await fetch(`${API_BASE}/ib-reminders/${id}`, { method: 'DELETE' });
        fetchReminders(currentPage);
        fetchTodaysReminders();
    } catch (err) {
        alert('Error deleting item');
    }
}

async function sendManual(id) {
    try {
        const response = await fetch(`${API_BASE}/ib-reminders/${id}?action=send`, {
            method: 'POST',
            headers: { 'X-User-Email': currentUser || '' }
        });
        const data = await response.json();
        if (data.success) {
            // Show toast-style message — status stays Pending (not Sent)
            showToast('✅ Test email sent successfully.', 'success');
        } else {
            showToast('❌ ' + (data.message || 'Failed to send test email'), 'error');
        }
    } catch (err) {
        showToast('❌ Server error while sending test email', 'error');
    }
}

// ── Simple toast notification ────────────────────────────────
function showToast(msg, type = 'success') {
    const existing = document.getElementById('app-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'app-toast';
    toast.textContent = msg;
    toast.style.cssText = `
        position:fixed; bottom:1.5rem; left:50%; transform:translateX(-50%) translateY(20px);
        background:${type === 'success' ? '#14532d' : '#450a0a'};
        color:${type === 'success' ? '#4ade80' : '#f87171'};
        border:1px solid ${type === 'success' ? '#166534' : '#7f1d1d'};
        padding:0.75rem 1.5rem; border-radius:0.75rem;
        font-size:0.87rem; font-weight:500;
        box-shadow:0 8px 24px rgba(0,0,0,0.5);
        z-index:9999; max-width:90vw; text-align:center;
        opacity:0; transition:opacity 0.25s, transform 0.25s;
    `;
    document.body.appendChild(toast);

    // Animate in
    requestAnimationFrame(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateX(-50%) translateY(0)';
    });

    // Auto-remove after 4 s
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(-50%) translateY(20px)';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}


// Add/Edit Form Handler
document.getElementById('add-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const editId = document.getElementById('edit_id').value;
    const formData = new FormData();
    formData.append('ib_id', document.getElementById('ib_id').value);
    formData.append('name', document.getElementById('contract_name').value);
    formData.append('start_date', document.getElementById('start_date').value);
    formData.append('end_date', document.getElementById('end_date').value);
    formData.append('reminder_date', document.getElementById('reminder_date').value);

    const reminderText = document.getElementById('reminder_text').value;
    const wordCount = reminderText.trim().split(/\s+/).length;
    if (reminderText && wordCount > 1000) {
        alert('Reminder text cannot exceed 1000 words.');
        return;
    }
    formData.append('reminder_text', reminderText);
    formData.append('created_by', currentUser);
    formData.append('targets', JSON.stringify(_targets));
    formData.append('payments', JSON.stringify(_payments));

    const fileInput = document.getElementById('contract');
    if (fileInput.files[0]) {
        formData.append('contract', fileInput.files[0]);
    }

    try {
        const url = editId ? `${API_BASE}/ib-reminders/${editId}` : `${API_BASE}/ib-reminders`;
        const method = editId ? 'PUT' : 'POST';

        const response = await fetch(url, { method, body: formData });
        const data = await response.json();
        if (data.success) {
            closeModal();
            fetchReminders(currentPage);
            fetchTodaysReminders();
            document.getElementById('add-form').reset();
            _targets = {}; _payments = [];
        }
    } catch (err) {
        alert('Error saving contract');
    }
});

// ── Control Panel ─────────────────────────────────────────────

function adminHeaders() {
    return { 'X-User-Email': currentUser, 'Content-Type': 'application/json' };
}

function openControlPanel() {
    document.getElementById('cp-modal').style.display = 'flex';
    loadUsers();
}

function closeControlPanel() {
    document.getElementById('cp-modal').style.display = 'none';
}

async function loadUsers() {
    try {
        const res = await fetch(`${API_BASE}/users`, { headers: adminHeaders() });
        const users = await res.json();
        const roleColors = { 'Admin': '#4f46e5', 'IB': '#0f766e', 'Account Manager': '#b45309', 'Backoffice': '#7e22ce' };
        const roleLabels = { 'Admin': 'Admin', 'IB': 'IB Dept', 'Account Manager': 'Account Mgr', 'Backoffice': 'Backoffice' };
        document.getElementById('cp-users-body').innerHTML = users.map(u => `
            <tr>
                <td>${u.email}</td>
                <td style="color:#a5b4fc;font-size:0.8rem;">${u.telegram_chat_id || '—'}</td>
                <td><span style="background:${roleColors[u.role] || '#52525b'};color:#fff;padding:2px 10px;border-radius:999px;font-size:0.75rem;">${roleLabels[u.role] || u.role}</span></td>
                <td style="color:#71717a;font-size:0.8rem;">${u.created_at ? u.created_at.slice(0, 10) : ''}</td>
                <td>
                    <div style="display:flex;gap:4px;">
                        <button onclick="openRoleModal(${u.id},'${u.email}','${u.role}','${u.telegram_chat_id || ''}')" title="Change Role"
                            style="width:28px;height:28px;border-radius:6px;border:none;background:#6366f1;color:#fff;cursor:pointer;font-size:11px;">
                            <i class="fa fa-pen"></i>
                        </button>
                        <button onclick="openResetPwModal(${u.id},'${u.email}')" title="Reset Password"
                            style="width:28px;height:28px;border-radius:6px;border:none;background:#0f766e;color:#fff;cursor:pointer;font-size:11px;">
                            <i class="fa fa-key"></i>
                        </button>
                        <button onclick="deleteUser(${u.id},'${u.email}')" title="Delete"
                            style="width:28px;height:28px;border-radius:6px;border:none;background:#ef4444;color:#fff;cursor:pointer;font-size:11px;">
                            <i class="fa fa-trash"></i>
                        </button>
                    </div>
                </td>
            </tr>
        `).join('');
    } catch (err) {
        console.error('Error loading users:', err);
    }
}

async function addUser() {
    const email = document.getElementById('cp-email').value.trim();
    const role = document.getElementById('cp-role').value;
    const password = document.getElementById('cp-password').value.trim();
    const telegram_chat_id = document.getElementById('cp-telegram').value.trim();
    const errEl = document.getElementById('cp-error');
    errEl.style.display = 'none';

    if (!email) { errEl.innerText = 'Email is required.'; errEl.style.display = 'block'; return; }
    if (!password) { errEl.innerText = 'Password is required.'; errEl.style.display = 'block'; return; }

    const res = await fetch(`${API_BASE}/users`, {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ email, role, password, telegram_chat_id })
    });
    const data = await res.json();
    if (data.success) {
        document.getElementById('cp-email').value = '';
        document.getElementById('cp-password').value = '';
        document.getElementById('cp-telegram').value = '';
        document.getElementById('cp-generated-box').style.display = 'none';
        loadUsers();
        showToast('✅ User added successfully.', 'success');
    } else {
        errEl.innerText = data.message || 'Error adding user.';
        errEl.style.display = 'block';
    }
}

// ── Password helpers ─────────────────────────────────────────
async function generateAndFill() {
    const res = await fetch(`${API_BASE}/users/generate-password`, { headers: adminHeaders() });
    const data = await res.json();
    if (data.password) {
        document.getElementById('cp-password').value = data.password;
        document.getElementById('cp-generated-pw').innerText = data.password;
        document.getElementById('cp-generated-box').style.display = 'block';
        // Show password in clear text after generate
        document.getElementById('cp-password').type = 'text';
        document.getElementById('cp-eye-icon').className = 'fa fa-eye-slash';
    }
}

function toggleCpPassword() {
    const inp = document.getElementById('cp-password');
    const icon = document.getElementById('cp-eye-icon');
    if (inp.type === 'password') { inp.type = 'text'; icon.className = 'fa fa-eye-slash'; }
    else { inp.type = 'password'; icon.className = 'fa fa-eye'; }
}

function copyGeneratedPw() {
    const pw = document.getElementById('cp-generated-pw').innerText;
    navigator.clipboard.writeText(pw).then(() => showToast('📋 Password copied to clipboard.', 'success'));
}

// ── Reset Password Modal ──────────────────────────────────────
let _resetPwUserId = null;
function openResetPwModal(id, email) {
    _resetPwUserId = id;
    document.getElementById('reset-pw-email').innerText = email;
    document.getElementById('reset-pw-input').value = '';
    document.getElementById('reset-pw-modal').style.display = 'flex';
}
function closeResetPwModal() {
    document.getElementById('reset-pw-modal').style.display = 'none';
    _resetPwUserId = null;
}
async function generateAndFillReset() {
    const res = await fetch(`${API_BASE}/users/generate-password`, { headers: adminHeaders() });
    const data = await res.json();
    if (data.password) {
        document.getElementById('reset-pw-input').value = data.password;
        document.getElementById('reset-pw-input').type = 'text';
        showToast('📋 Generated: ' + data.password, 'success');
        navigator.clipboard.writeText(data.password).catch(() => { });
    }
}
async function saveResetPassword() {
    const password = document.getElementById('reset-pw-input').value.trim();
    if (!password) { alert('Enter a new password.'); return; }
    const res = await fetch(`${API_BASE}/users/${_resetPwUserId}/reset-password`, {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ password })
    });
    const data = await res.json();
    if (data.success) {
        closeResetPwModal();
        showToast('✅ Password updated successfully.', 'success');
    } else {
        alert(data.message || 'Error resetting password.');
    }
}

async function deleteUser(id, email) {
    if (!confirm(`Delete user "${email}"?`)) return;
    const res = await fetch(`${API_BASE}/users/${id}`, { method: 'DELETE', headers: adminHeaders() });
    const data = await res.json();
    if (data.success) loadUsers();
    else alert(data.message || 'Error deleting user.');
}

function openRoleModal(id, email, currentRoleVal, telegramChatId) {
    document.getElementById('role-user-id').value = id;
    document.getElementById('role-user-email').innerText = email;
    document.getElementById('role-select').value = currentRoleVal;
    document.getElementById('role-telegram').value = telegramChatId || '';
    document.getElementById('role-modal').style.display = 'flex';
}

function closeRoleModal() {
    document.getElementById('role-modal').style.display = 'none';
}

async function saveRole() {
    const id = document.getElementById('role-user-id').value;
    const role = document.getElementById('role-select').value;
    const telegram_chat_id = document.getElementById('role-telegram').value.trim();
    const res = await fetch(`${API_BASE}/users/${id}`, {
        method: 'PUT',
        headers: adminHeaders(),
        body: JSON.stringify({ role, telegram_chat_id })
    });
    const data = await res.json();
    if (data.success) { closeRoleModal(); loadUsers(); }
    else alert(data.message || 'Error updating role.');
}

// ── Tab switching ──────────────────────────────────────────────
function switchTab(tab) {
    // Account Manager: Campaigns-only — block any attempt to switch to Reminder
    if (currentRole === 'Account Manager' && tab === 'reminder') return;

    const isReminder = tab === 'reminder';
    document.getElementById('section-reminder').style.display = isReminder ? 'block' : 'none';
    document.getElementById('section-campaigns').style.display = !isReminder ? 'block' : 'none';

    const btnR = document.getElementById('tab-reminder');
    const btnC = document.getElementById('tab-campaigns');
    btnR.style.color = isReminder ? '#fafafa' : '#71717a';
    btnR.style.borderBottom = isReminder ? '3px solid #6366f1' : '3px solid transparent';
    btnC.style.color = !isReminder ? '#fafafa' : '#71717a';
    btnC.style.borderBottom = !isReminder ? '3px solid #6366f1' : '3px solid transparent';

    if (!isReminder) fetchCampaigns(1);
    else { fetchReminders(); fetchTodaysReminders(); }
}


// ── IB Campaigns ───────────────────────────────────────────────
async function fetchCampaigns(page = 1) {
    campPage = page;
    const search = document.getElementById('camp-search').value.trim();
    const sortVal = document.getElementById('camp-sort').value; // e.g. "campaign_start-asc"
    const [sort_by, sort_dir] = sortVal.split('-');

    try {
        const res = await fetch(`${API_BASE}/ib-campaigns?page=${page}&search=${encodeURIComponent(search)}&sort_by=${sort_by}&sort_dir=${sort_dir}`);
        const data = await res.json();
        currentCampaigns = data.campaigns;
        renderCampaigns(data.campaigns);
        renderCampPagination(data.total_pages);
    } catch (err) {
        console.error('Error fetching campaigns:', err);
    }
}

function renderCampaigns(campaigns) {
    const tbody = document.getElementById('camp-table-body');
    const canEdit = currentRole === 'Admin' || currentRole === 'IB';

    // Hide Actions column header for Account Manager
    document.getElementById('camp-actions-header').style.display = canEdit ? '' : 'none';
    // Hide Add button for Account Manager
    const addBtn = document.getElementById('camp-add-btn');
    if (addBtn) addBtn.style.display = canEdit ? '' : 'none';

    if (!campaigns || campaigns.length === 0) {
        tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:#71717a;">No campaigns found.</td></tr>`;
        return;
    }

    tbody.innerHTML = campaigns.map(c => {
        const isActive = c.status === 'Active';
        const statusBadge = isActive
            ? `<span style="background:#14532d;color:#4ade80;padding:3px 10px;border-radius:999px;font-size:0.75rem;font-weight:600;">● Active</span>`
            : `<span style="background:#450a0a;color:#f87171;padding:3px 10px;border-radius:999px;font-size:0.75rem;font-weight:600;">● Deactive</span>`;

        const actionsCell = canEdit ? `
            <td data-label="Actions">
                <div style="display:flex;gap:4px;">
                    <button onclick="editCampaign(${c.id})" title="Edit"
                        style="width:28px;height:28px;border-radius:6px;border:none;background:#3b82f6;color:#fff;cursor:pointer;font-size:11px;">
                        <i class="fa fa-pen"></i>
                    </button>
                    <button onclick="deleteCampaign(${c.id})" title="Delete"
                        style="width:28px;height:28px;border-radius:6px;border:none;background:#ef4444;color:#fff;cursor:pointer;font-size:11px;">
                        <i class="fa fa-trash"></i>
                    </button>
                </div>
            </td>` : `<td style="display:none"></td>`;

        const keypointsShort = c.keypoints && c.keypoints.length > 60
            ? c.keypoints.slice(0, 60) + '…'
            : (c.keypoints || '—');

        return `
            <tr onclick="showCampDetail(${c.id})" style="cursor:pointer;" title="Click to view details">
                <td data-label="IB ID">${c.ib_id}</td>
                <td data-label="Name">${c.name || '—'}</td>
                <td data-label="Start">${c.campaign_start}</td>
                <td data-label="End">${c.campaign_end}</td>
                <td data-label="Offer">${c.offer || '—'}</td>
                <td data-label="Keypoints" title="${c.keypoints || ''}" style="max-width:180px;cursor:default;">${keypointsShort}</td>
                <td data-label="Manager">${c.ib_manager}</td>
                <td data-label="Status">${statusBadge}</td>
                ${actionsCell}
            </tr>`;
    }).join('');
}

function renderCampPagination(totalPages) {
    const container = document.getElementById('camp-pagination');
    let html = '';
    for (let i = 1; i <= totalPages; i++) {
        html += `<button class="page-btn ${i === campPage ? 'active' : ''}" onclick="fetchCampaigns(${i})">${i}</button>`;
    }
    container.innerHTML = html;
}

// Campaign search debounce
let campSearchTimeout;
document.getElementById('camp-search').addEventListener('input', () => {
    clearTimeout(campSearchTimeout);
    campSearchTimeout = setTimeout(() => fetchCampaigns(1), 500);
});

// Campaign modal
function openCampModal(id = null) {
    document.getElementById('camp-modal-title').innerText = id ? 'Edit Campaign' : 'Add Campaign';
    document.getElementById('camp-edit-id').value = id || '';
    if (!id) document.getElementById('camp-form').reset();
    document.getElementById('camp-modal').style.display = 'flex';
}

function closeCampModal() {
    document.getElementById('camp-modal').style.display = 'none';
}

function editCampaign(id) {
    const c = currentCampaigns.find(x => x.id === id);
    if (!c) return;
    document.getElementById('camp-modal-title').innerText = 'Edit Campaign';
    document.getElementById('camp-edit-id').value = c.id;
    document.getElementById('camp-ib-id').value = c.ib_id;
    document.getElementById('camp-name').value = c.name || '';
    document.getElementById('camp-start').value = c.campaign_start;
    document.getElementById('camp-end').value = c.campaign_end;
    document.getElementById('camp-offer').value = c.offer || '';
    document.getElementById('camp-keypoints').value = c.keypoints || '';
    document.getElementById('camp-ib-manager').value = c.ib_manager;
    document.getElementById('camp-modal').style.display = 'flex';
}

async function deleteCampaign(id) {
    if (!confirm('Delete this campaign?')) return;
    await fetch(`${API_BASE}/ib-campaigns/${id}`, {
        method: 'DELETE',
        headers: { 'X-User-Email': currentUser }
    });
    fetchCampaigns(campPage);
}

document.getElementById('camp-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const editId = document.getElementById('camp-edit-id').value;
    const formData = new FormData();
    formData.append('ib_id', document.getElementById('camp-ib-id').value);
    formData.append('name', document.getElementById('camp-name').value);
    formData.append('campaign_start', document.getElementById('camp-start').value);
    formData.append('campaign_end', document.getElementById('camp-end').value);
    formData.append('offer', document.getElementById('camp-offer').value);
    formData.append('keypoints', document.getElementById('camp-keypoints').value);
    formData.append('ib_manager', document.getElementById('camp-ib-manager').value);
    formData.append('created_by', currentUser);

    const url = editId ? `${API_BASE}/ib-campaigns/${editId}` : `${API_BASE}/ib-campaigns`;
    const method = editId ? 'PUT' : 'POST';
    const opts = editId
        ? { method, body: formData, headers: { 'X-User-Email': currentUser } }
        : { method, body: formData };

    const res = await fetch(url, opts);
    const data = await res.json();
    if (data.success) { closeCampModal(); fetchCampaigns(campPage); }
    else alert(data.message || 'Error saving campaign.');
});

// ── Campaign Detail Popup (row click) ─────────────────────────

function showCampDetail(id) {
    const c = currentCampaigns.find(x => x.id === id);
    if (!c) return;

    const isActive = c.status === 'Active';
    const statusBadge = isActive
        ? `<span style="background:#14532d;color:#4ade80;padding:4px 14px;border-radius:999px;font-weight:700;">● Active</span>`
        : `<span style="background:#450a0a;color:#f87171;padding:4px 14px;border-radius:999px;font-weight:700;">● Deactive</span>`;

    const field = (label, value, accent = false) => `
        <div style="background:#27272a;border-radius:0.6rem;padding:0.9rem 1.1rem;">
            <div style="font-size:0.72rem;color:#71717a;text-transform:uppercase;letter-spacing:1px;margin-bottom:0.3rem;">${label}</div>
            <div style="color:${accent ? '#a5b4fc' : '#fafafa'};font-size:0.95rem;line-height:1.6;white-space:pre-wrap;">${value || '—'}</div>
        </div>`;

    document.getElementById('camp-detail-body').innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;">
            ${field('IB ID', c.ib_id, true)}
            ${field('IB Manager', c.ib_manager)}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;">
            ${field('Campaign Start', c.campaign_start)}
            ${field('Campaign End', c.campaign_end)}
        </div>
        ${field('Status', statusBadge)}
        ${field('Offer', c.offer)}
        ${field('Keypoints', c.keypoints)}
        <div style="font-size:0.75rem;color:#52525b;text-align:right;">
            Added by ${c.created_by} &nbsp;·&nbsp; ${c.created_at ? c.created_at.slice(0, 10) : ''}
        </div>`;

    document.getElementById('camp-detail-modal').style.display = 'flex';
}

// ── Export (CSV / PDF) ────────────────────────────────────────

let dlFormat = 'csv';

function openDownload(format) {
    dlFormat = format;
    document.getElementById('dl-format').value = format;
    const icon = format === 'csv' ? '🟢 CSV' : '🔴 PDF';
    document.getElementById('dl-modal-title').innerHTML =
        `<i class="fa fa-download" style="color:#6366f1;margin-right:0.5rem;"></i> Export as ${icon}`;
    document.getElementById('download-modal').style.display = 'flex';
}

async function runExport() {
    const status = document.querySelector('input[name="dl-status"]:checked').value;
    const dateFrom = document.getElementById('dl-from').value;
    const dateTo = document.getElementById('dl-to').value;

    let url = `${API_BASE}/ib-campaigns/export?status=${status}`;
    if (dateFrom) url += `&date_from=${dateFrom}`;
    if (dateTo) url += `&date_to=${dateTo}`;

    const res = await fetch(url);
    const rows = await res.json();

    if (!rows.length) { alert('No campaigns match the selected filters.'); return; }

    document.getElementById('download-modal').style.display = 'none';

    if (dlFormat === 'csv') exportCSV(rows);
    else exportPDF(rows);
}

function exportCSV(rows) {
    const headers = ['IB ID', 'Campaign Start', 'Campaign End', 'Offer', 'Keypoints', 'IB Manager', 'Status'];
    const lines = [headers.join(',')];
    rows.forEach(r => {
        const vals = [
            r.ib_id, r.campaign_start, r.campaign_end,
            `"${(r.offer || '').replace(/"/g, '""')}"`,
            `"${(r.keypoints || '').replace(/"/g, '""')}"`,
            r.ib_manager, r.status
        ];
        lines.push(vals.join(','));
    });
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ib_campaigns_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

function exportPDF(rows) {
    // Use server-side PDF generation (Vazirmatn font — Persian support)
    const status = document.querySelector('input[name="dl-status"]:checked').value;
    const dateFrom = document.getElementById('dl-from').value;
    const dateTo = document.getElementById('dl-to').value;

    let url = `http://localhost:5000/api/ib-campaigns/export-pdf?status=${status}`;
    if (dateFrom) url += `&date_from=${dateFrom}`;
    if (dateTo) url += `&date_to=${dateTo}`;

    // Server returns a PDF binary — open in new tab triggers browser download
    window.open(url, '_blank');
}
