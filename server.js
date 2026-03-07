const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: process.env.SESSION_SECRET || 'woods-landing-secret-2024',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

// ═══════════════════════════════════════════
// DATABASE SETUP — PostgreSQL (Render) or SQLite (local)
// ═══════════════════════════════════════════
let db;
let isPostgres = false;

async function setupDatabase() {
    if (process.env.DATABASE_URL) {
        // PostgreSQL on Render
        isPostgres = true;
        const { Pool } = require('pg');
        db = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false }
        });
        console.log('✅ Using PostgreSQL');
        await initPostgres();
    } else {
        // SQLite for local dev
        const sqlite3 = require('sqlite3').verbose();
        const DB_PATH = path.join(__dirname, 'timeclock.db');
        db = new sqlite3.Database(DB_PATH);
        console.log('✅ Using SQLite at', DB_PATH);
        await initSQLite();
    }
}

// Unified query wrapper
async function query(sql, params = []) {
    if (isPostgres) {
        // Convert ? placeholders to $1, $2...
        let i = 0;
        const pgSql = sql.replace(/\?/g, () => `$${++i}`);
        const result = await db.query(pgSql, params);
        return result.rows;
    } else {
        return new Promise((resolve, reject) => {
            if (sql.trim().toUpperCase().startsWith('SELECT') || sql.trim().toUpperCase().startsWith('WITH')) {
                db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
            } else {
                db.run(sql, params, function(err) {
                    if (err) reject(err);
                    else resolve([{ lastID: this.lastID, changes: this.changes }]);
                });
            }
        });
    }
}

async function initPostgres() {
    await db.query(`
        CREATE TABLE IF NOT EXISTS employees (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            pin TEXT NOT NULL,
            role TEXT DEFAULT 'employee',
            hourly_rate REAL DEFAULT 15.00,
            pay_period TEXT DEFAULT 'weekly',
            active INTEGER DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS punches (
            id SERIAL PRIMARY KEY,
            employee_id INTEGER REFERENCES employees(id),
            punch_type TEXT CHECK(punch_type IN ('in','out','break_start','break_end')),
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            note TEXT
        )
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS tips (
            id SERIAL PRIMARY KEY,
            employee_id INTEGER REFERENCES employees(id),
            date TEXT DEFAULT CURRENT_DATE,
            total_tips REAL DEFAULT 0,
            reported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS backups (
            id SERIAL PRIMARY KEY,
            backup_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            type TEXT DEFAULT 'manual',
            status TEXT DEFAULT 'success',
            stats JSONB
        )
    `);
    // Add pay_period column if missing
    await db.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS pay_period TEXT DEFAULT 'weekly'`).catch(() => {});
    await seedEmployees();
}

async function initSQLite() {
    await query(`CREATE TABLE IF NOT EXISTS employees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        pin TEXT NOT NULL,
        role TEXT DEFAULT 'employee',
        hourly_rate REAL DEFAULT 15.00,
        pay_period TEXT DEFAULT 'weekly',
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    await query(`ALTER TABLE employees ADD COLUMN pay_period TEXT DEFAULT 'weekly'`).catch(() => {});
    await query(`CREATE TABLE IF NOT EXISTS punches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER,
        punch_type TEXT CHECK(punch_type IN ('in','out','break_start','break_end')),
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        note TEXT,
        FOREIGN KEY(employee_id) REFERENCES employees(id)
    )`);
    await query(`CREATE TABLE IF NOT EXISTS tips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER,
        date TEXT DEFAULT CURRENT_DATE,
        total_tips REAL DEFAULT 0,
        reported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(employee_id) REFERENCES employees(id)
    )`);
    await query(`CREATE TABLE IF NOT EXISTS backups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        backup_date DATETIME DEFAULT CURRENT_TIMESTAMP,
        type TEXT DEFAULT 'manual',
        status TEXT DEFAULT 'success',
        stats TEXT
    )`);
    await seedEmployees();
}

async function seedEmployees() {
    const rows = await query('SELECT COUNT(*) as count FROM employees');
    const count = parseInt(rows[0].count || rows[0]['COUNT(*)'] || 0);
    if (count > 0) return;
    const employees = [
        ['Marline','1111',15.00,'employee'],
        ['Aaron','2222',15.00,'employee'],
        ['Christopher','3333',15.00,'employee'],
        ['Gigi','4444',15.00,'employee'],
        ['Natalie','5555',15.00,'employee'],
        ['Kara','6666',15.00,'employee'],
        ['Sarah','7777',15.00,'employee'],
        ['Nathan','8888',15.00,'employee'],
        ['Manager','1234',25.00,'admin']
    ];
    for (const [name, pin, rate, role] of employees) {
        const hashed = bcrypt.hashSync(pin, 10);
        await query('INSERT INTO employees (name,pin,hourly_rate,role) VALUES (?,?,?,?)', [name, hashed, rate, role]);
    }
    console.log('✅ Employees seeded');
}

// ═══════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════
function requireAdmin(req, res, next) {
    if (req.session.role !== 'admin') return res.status(403).json({ success: false, message: 'Admin only' });
    next();
}

function calcMinutes(punches) {
    let mins = 0, lastIn = null;
    [...punches].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)).forEach(p => {
        if (p.punch_type === 'in') lastIn = new Date(p.timestamp);
        else if (p.punch_type === 'out' && lastIn) {
            mins += (new Date(p.timestamp) - lastIn) / 60000;
            lastIn = null;
        }
    });
    return mins;
}

// Fix date filter for both SQLite and Postgres
function dateFilter(col, start, end) {
    if (isPostgres) return `AND DATE(${col}) BETWEEN '${start}' AND '${end}'`;
    return `AND date(${col}) BETWEEN '${start}' AND '${end}'`;
}
function dateLocal() {
    if (isPostgres) return `DATE(NOW())`;
    return `date('now','localtime')`;
}

// ═══════════════════════════════════════════
// EMAIL
// ═══════════════════════════════════════════
function getMailer() {
    const { EMAIL_USER, EMAIL_PASS } = process.env;
    if (!EMAIL_USER || !EMAIL_PASS) return null;
    return nodemailer.createTransport({ service: 'gmail', auth: { user: EMAIL_USER, pass: EMAIL_PASS } });
}

async function buildReportText(start, end) {
    const punches = await query(
        `SELECT p.*,e.name as employee_name,e.hourly_rate FROM punches p JOIN employees e ON p.employee_id=e.id WHERE DATE(p.timestamp) BETWEEN ? AND ? ORDER BY e.name,p.timestamp`,
        [start, end]
    );
    const tips = await query(
        `SELECT t.*,e.name as employee_name FROM tips t JOIN employees e ON t.employee_id=e.id WHERE t.date BETWEEN ? AND ? ORDER BY e.name`,
        [start, end]
    );
    const empData = {};
    punches.forEach(p => {
        if (!empData[p.employee_name]) empData[p.employee_name] = { punches: [], hourly_rate: p.hourly_rate };
        empData[p.employee_name].punches.push(p);
    });
    const tipsByEmp = {};
    tips.forEach(t => { tipsByEmp[t.employee_name] = (tipsByEmp[t.employee_name] || 0) + (t.total_tips || 0); });
    let text = `WOODS LANDING TIME CLOCK REPORT\nPeriod: ${start} to ${end}\nGenerated: ${new Date().toLocaleString()}\n${'='.repeat(52)}\n\n`;
    let grandH = 0, grandP = 0, grandT = 0;
    Object.entries(empData).forEach(([name, data]) => {
        const h = calcMinutes(data.punches) / 60;
        const p = h * data.hourly_rate;
        const t = tipsByEmp[name] || 0;
        grandH += h; grandP += p; grandT += t;
        text += `${name}\n  Hours: ${h.toFixed(2)} @ $${data.hourly_rate}/hr = $${p.toFixed(2)}\n  Tips: $${t.toFixed(2)}\n  Total Earnings: $${(p + t).toFixed(2)}\n\n`;
    });
    text += `${'='.repeat(52)}\nTOTALS\n  Total Hours: ${grandH.toFixed(2)}\n  Total Gross Pay: $${grandP.toFixed(2)}\n  Total Tips: $${grandT.toFixed(2)}\n  Total Earnings: $${(grandP + grandT).toFixed(2)}\n`;
    return { text, punches, tips };
}

// ═══════════════════════════════════════════
// WEEKLY AUTO-BACKUP EMAIL
// ═══════════════════════════════════════════
async function sendWeeklyBackup() {
    const mailer = getMailer();
    const REPORT_EMAIL = process.env.REPORT_EMAIL;
    if (!mailer || !REPORT_EMAIL) { console.log('Weekly backup: email not configured, skipping'); return; }

    try {
        const today = new Date();
        const weekAgo = new Date(today); weekAgo.setDate(today.getDate() - 7);
        const start = weekAgo.toISOString().split('T')[0];
        const end = today.toISOString().split('T')[0];

        const { text, punches, tips } = await buildReportText(start, end);

        // Build full JSON backup
        const allEmps = await query('SELECT id,name,role,hourly_rate,pay_period,active,created_at FROM employees ORDER BY name');
        const allPunches = await query('SELECT * FROM punches ORDER BY timestamp');
        const allTips = await query('SELECT * FROM tips ORDER BY date');
        const fullBackup = JSON.stringify({ exported: new Date().toISOString(), employees: allEmps, punches: allPunches, tips: allTips }, null, 2);

        await mailer.sendMail({
            from: process.env.EMAIL_USER,
            to: REPORT_EMAIL,
            subject: `🌲 Woods Landing Weekly Report: ${start} to ${end}`,
            text: text,
            attachments: [
                { filename: `woods-landing-report-${end}.txt`, content: text },
                { filename: `woods-landing-full-backup-${end}.json`, content: fullBackup }
            ]
        });

        // Log the backup
        const stats = JSON.stringify({ employees: allEmps.length, punches: allPunches.length, tips: allTips.length });
        await query(`INSERT INTO backups (type, status, stats) VALUES (?,?,?)`, ['weekly_auto', 'success', stats]);
        console.log('✅ Weekly backup email sent to', REPORT_EMAIL);
    } catch (err) {
        console.error('Weekly backup failed:', err.message);
        await query(`INSERT INTO backups (type, status, stats) VALUES (?,?,?)`, ['weekly_auto', 'failed', JSON.stringify({ error: err.message })]).catch(() => {});
    }
}

// Schedule weekly backup every Sunday at 11pm
function scheduleWeeklyBackup() {
    const checkAndSend = () => {
        const now = new Date();
        if (now.getDay() === 0 && now.getHours() === 23 && now.getMinutes() < 5) {
            sendWeeklyBackup();
        }
    };
    setInterval(checkAndSend, 5 * 60 * 1000); // check every 5 minutes
    console.log('✅ Weekly backup scheduler running (Sundays 11pm)');
}

// ═══════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════
app.get('/api/health', (req, res) => res.json({ success: true }));

app.post('/api/login', async (req, res) => {
    const { pin } = req.body;
    if (!pin) return res.status(400).json({ success: false, message: 'PIN required' });
    try {
        const employees = await query('SELECT * FROM employees WHERE active=1');
        const emp = employees.find(e => bcrypt.compareSync(pin, e.pin));
        if (emp) {
            req.session.employeeId = emp.id;
            req.session.employeeName = emp.name;
            req.session.role = emp.role;
            res.json({ success: true, employee: { id: emp.id, name: emp.name, role: emp.role } });
        } else {
            res.status(401).json({ success: false, message: 'Invalid PIN' });
        }
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

app.get('/api/status', async (req, res) => {
    if (!req.session.employeeId) return res.status(401).json({ success: false });
    try {
        const rows = await query(
            `SELECT * FROM punches WHERE employee_id=? AND DATE(timestamp)=${dateLocal()} ORDER BY timestamp DESC LIMIT 1`,
            [req.session.employeeId]
        );
        res.json({ success: true, employeeName: req.session.employeeName, role: req.session.role, lastPunch: rows[0] || null });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ═══════════════════════════════════════════
// CLOCK ROUTES
// ═══════════════════════════════════════════
app.post('/api/clock', async (req, res) => {
    if (!req.session.employeeId) return res.status(401).json({ success: false });
    const { type } = req.body;
    if (!['in','out','break_start','break_end'].includes(type)) return res.status(400).json({ success: false });
    try {
        await query('INSERT INTO punches (employee_id,punch_type) VALUES (?,?)', [req.session.employeeId, type]);
        res.json({ success: true, type, timestamp: new Date().toISOString() });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ═══════════════════════════════════════════
// TIPS ROUTES
// ═══════════════════════════════════════════
app.post('/api/tips/report', async (req, res) => {
    if (!req.session.employeeId) return res.status(401).json({ success: false });
    const amount = parseFloat(req.body.total_tips) || 0;
    const today = new Date().toISOString().split('T')[0];
    try {
        // Check if there's already a tips entry for today
        const existing = await query('SELECT * FROM tips WHERE employee_id=? AND date=?', [req.session.employeeId, today]);
        let newTotal;
        if (existing.length > 0) {
            // Add to existing amount
            newTotal = parseFloat(existing[0].total_tips || 0) + amount;
            await query('UPDATE tips SET total_tips=?, reported_at=CURRENT_TIMESTAMP WHERE employee_id=? AND date=?',
                [newTotal, req.session.employeeId, today]);
        } else {
            // First entry of the day
            newTotal = amount;
            await query('INSERT INTO tips (employee_id,date,total_tips) VALUES (?,?,?)', [req.session.employeeId, today, amount]);
        }
        res.json({ success: true, total: newTotal, added: amount });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/tips/today', async (req, res) => {
    if (!req.session.employeeId) return res.status(401).json({ success: false });
    const today = new Date().toISOString().split('T')[0];
    try {
        const rows = await query('SELECT * FROM tips WHERE employee_id=? AND date=? ORDER BY reported_at DESC LIMIT 1', [req.session.employeeId, today]);
        res.json({ success: true, tip: rows[0] || { total_tips: 0 } });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ═══════════════════════════════════════════
// PUBLIC — employee list for PIN pad display (names only, no sensitive data)
app.get('/api/employees/list', async (req, res) => {
    try {
        const rows = await query("SELECT id, name, role FROM employees WHERE active=1 ORDER BY name");
        res.json({ success: true, employees: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ADMIN — EMPLOYEES
// ═══════════════════════════════════════════
app.get('/api/admin/employees', requireAdmin, async (req, res) => {
    try {
        const rows = await query('SELECT id,name,role,hourly_rate,pay_period,active,created_at FROM employees ORDER BY name');
        res.json({ success: true, employees: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/admin/employees', requireAdmin, async (req, res) => {
    const { name, pin, hourly_rate, role } = req.body;
    if (!name || !pin) return res.status(400).json({ success: false, message: 'Name and PIN required' });
    try {
        const rows = await query(
            'INSERT INTO employees (name,pin,hourly_rate,role) VALUES (?,?,?,?)',
            [name, bcrypt.hashSync(pin, 10), parseFloat(hourly_rate) || 15.00, role || 'employee']
        );
        res.json({ success: true, id: rows[0]?.lastID || rows[0]?.id });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.put('/api/admin/employees/:id', requireAdmin, async (req, res) => {
    const { name, hourly_rate, active, pin, pay_period } = req.body;
    const pp = pay_period || 'weekly';
    try {
        if (pin && pin.length === 4) {
            await query('UPDATE employees SET name=?,hourly_rate=?,active=?,pin=?,pay_period=? WHERE id=?',
                [name, parseFloat(hourly_rate), active, bcrypt.hashSync(pin, 10), pp, req.params.id]);
        } else {
            await query('UPDATE employees SET name=?,hourly_rate=?,active=?,pay_period=? WHERE id=?',
                [name, parseFloat(hourly_rate), active, pp, req.params.id]);
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ═══════════════════════════════════════════
// ADMIN — EMPLOYEE PROFILE
// ═══════════════════════════════════════════
app.get('/api/admin/employee/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { start, end } = req.query;
    try {
        const emps = await query('SELECT id,name,role,hourly_rate,pay_period,active,created_at FROM employees WHERE id=?', [id]);
        if (!emps.length) return res.status(404).json({ success: false, message: 'Not found' });
        const emp = emps[0];

        // Use parameterized dates to avoid SQL issues across both DB types
        let punches, tips;
        if (start && end) {
            punches = await query(
                `SELECT * FROM punches WHERE employee_id=? AND DATE(timestamp) BETWEEN ? AND ? ORDER BY timestamp ASC`,
                [id, start, end]
            );
            tips = await query(
                `SELECT * FROM tips WHERE employee_id=? AND date BETWEEN ? AND ? ORDER BY date ASC`,
                [id, start, end]
            );
        } else {
            punches = await query(`SELECT * FROM punches WHERE employee_id=? ORDER BY timestamp ASC`, [id]);
            tips = await query(`SELECT * FROM tips WHERE employee_id=? ORDER BY date ASC`, [id]);
        }

        const mins = calcMinutes(punches);
        const hours = mins / 60;
        const gross = hours * emp.hourly_rate;
        const totalTips = tips.reduce((s, t) => s + (parseFloat(t.total_tips) || 0), 0);

        res.json({
            success: true, employee: emp,
            stats: { totalHours: hours.toFixed(2), grossPay: gross.toFixed(2), totalTips: totalTips.toFixed(2) },
            punches, tips
        });
    } catch (err) {
        console.error('Profile error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ═══════════════════════════════════════════
// ADMIN — REPORTS
// ═══════════════════════════════════════════
app.get('/api/report/punches', requireAdmin, async (req, res) => {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ success: false });
    try {
        const rows = await query(
            `SELECT p.*,e.name as employee_name,e.hourly_rate FROM punches p JOIN employees e ON p.employee_id=e.id WHERE DATE(p.timestamp) BETWEEN ? AND ? ORDER BY e.name,p.timestamp`,
            [start, end]
        );
        res.json({ success: true, punches: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/report/tips', requireAdmin, async (req, res) => {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ success: false });
    try {
        const rows = await query(
            `SELECT t.*,e.name as employee_name FROM tips t JOIN employees e ON t.employee_id=e.id WHERE t.date BETWEEN ? AND ? ORDER BY e.name,t.date`,
            [start, end]
        );
        res.json({ success: true, tips: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ═══════════════════════════════════════════
// ADMIN — TAX REPORT
// ═══════════════════════════════════════════
app.get('/api/report/tax', requireAdmin, async (req, res) => {
    const y = req.query.year || new Date().getFullYear();
    const start = `${y}-01-01`, end = `${y}-12-31`;
    try {
        const employees = await query("SELECT id,name,hourly_rate FROM employees WHERE role='employee' ORDER BY name");
        if (!employees.length) return res.json({ success: true, year: y, employees: [] });

        const results = await Promise.all(employees.map(async emp => {
            const punches = await query(
                `SELECT * FROM punches WHERE employee_id=? AND DATE(timestamp) BETWEEN ? AND ? ORDER BY timestamp`,
                [emp.id, start, end]
            );
            const tips = await query(
                `SELECT * FROM tips WHERE employee_id=? AND date BETWEEN ? AND ? ORDER BY date`,
                [emp.id, start, end]
            );
            const mins = calcMinutes(punches);
            const hours = mins / 60, gross = hours * emp.hourly_rate;
            const totalTips = tips.reduce((s, t) => s + (t.total_tips || 0), 0);

            const monthly = {};
            for (let m = 1; m <= 12; m++) monthly[m] = { hours: '0.00', gross: '0.00', tips: '0.00' };
            const mPunches = {};
            punches.forEach(p => { const m = new Date(p.timestamp).getMonth() + 1; if (!mPunches[m]) mPunches[m] = []; mPunches[m].push(p); });
            Object.entries(mPunches).forEach(([m, ps]) => {
                const mm = calcMinutes(ps);
                monthly[m].hours = (mm / 60).toFixed(2);
                monthly[m].gross = ((mm / 60) * emp.hourly_rate).toFixed(2);
            });
            tips.forEach(t => {
                const m = new Date(t.date + 'T00:00:00').getMonth() + 1;
                monthly[m].tips = (parseFloat(monthly[m].tips) + (t.total_tips || 0)).toFixed(2);
            });
            return { id: emp.id, name: emp.name, hourly_rate: emp.hourly_rate, total_hours: hours.toFixed(2), total_gross: gross.toFixed(2), total_tips: totalTips.toFixed(2), total_earnings: (gross + totalTips).toFixed(2), monthly };
        }));
        res.json({ success: true, year: y, employees: results });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ═══════════════════════════════════════════
// ADMIN — BACKUP ROUTES
// ═══════════════════════════════════════════
app.post('/api/admin/backup', requireAdmin, async (req, res) => {
    try {
        const allEmps = await query('SELECT id,name,role,hourly_rate,pay_period,active,created_at FROM employees ORDER BY name');
        const allPunches = await query('SELECT * FROM punches ORDER BY timestamp');
        const allTips = await query('SELECT * FROM tips ORDER BY date');
        const backup = { exported: new Date().toISOString(), employees: allEmps, punches: allPunches, tips: allTips };
        const stats = JSON.stringify({ employees: allEmps.length, punches: allPunches.length, tips: allTips.length });
        await query(`INSERT INTO backups (type,status,stats) VALUES (?,?,?)`, ['manual', 'success', stats]);
        res.json({ success: true, backup, stats: { employees: allEmps.length, punches: allPunches.length, tips: allTips.length } });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/admin/backups', requireAdmin, async (req, res) => {
    try {
        const rows = await query('SELECT * FROM backups ORDER BY backup_date DESC LIMIT 20');
        res.json({ success: true, backups: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ═══════════════════════════════════════════
// ADMIN — EMAIL REPORT
// ═══════════════════════════════════════════
app.post('/api/send-report', requireAdmin, async (req, res) => {
    const { startDate, endDate } = req.body;
    if (!startDate || !endDate) return res.status(400).json({ success: false });
    try {
        const { text } = await buildReportText(startDate, endDate);
        const mailer = getMailer();
        const REPORT_EMAIL = process.env.REPORT_EMAIL;
        if (mailer && REPORT_EMAIL) {
            await mailer.sendMail({
                from: process.env.EMAIL_USER,
                to: REPORT_EMAIL,
                subject: `Woods Landing Report: ${startDate} to ${endDate}`,
                text,
                attachments: [{ filename: `report-${endDate}.txt`, content: text }]
            });
            res.json({ success: true, message: `Emailed to ${REPORT_EMAIL}` });
        } else {
            res.json({ success: true, emailFailed: true, report: text });
        }
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ═══════════════════════════════════════════
// START
// ═══════════════════════════════════════════
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

setupDatabase().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`✅ Woods Landing server running on port ${PORT}`);
        scheduleWeeklyBackup();
    });
}).catch(err => {
    console.error('Failed to start:', err);
    process.exit(1);
});
