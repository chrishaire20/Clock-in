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
        isPostgres = true;
        const { Pool } = require('pg');
        db = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false }
        });
        console.log('✅ Using PostgreSQL');
        await initPostgres();
    } else {
        const sqlite3 = require('sqlite3').verbose();
        const DB_PATH = path.join(__dirname, 'timeclock.db');
        db = new sqlite3.Database(DB_PATH);
        console.log('✅ Using SQLite at', DB_PATH);
        await initSQLite();
    }
}

async function query(sql, params = []) {
    if (isPostgres) {
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
    // Employees table
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

    // Roles table - available roles in the restaurant
    await db.query(`
        CREATE TABLE IF NOT EXISTS roles (
            id SERIAL PRIMARY KEY,
            name TEXT UNIQUE NOT NULL,
            description TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Employee role assignments - which roles each employee is allowed to work
    await db.query(`
        CREATE TABLE IF NOT EXISTS employee_roles (
            id SERIAL PRIMARY KEY,
            employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE,
            role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(employee_id, role_id)
        )
    `);

    // Punches table with role_id
    await db.query(`
        CREATE TABLE IF NOT EXISTS punches (
            id SERIAL PRIMARY KEY,
            employee_id INTEGER REFERENCES employees(id),
            role_id INTEGER REFERENCES roles(id),
            punch_type TEXT CHECK(punch_type IN ('in','out','break_start','break_end')),
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            note TEXT,
            edited_by INTEGER REFERENCES employees(id),
            edited_at TIMESTAMP,
            original_timestamp TIMESTAMP
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

    await db.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS pay_period TEXT DEFAULT 'weekly'`).catch(() => {});
    
    await seedRoles();
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

    await query(`CREATE TABLE IF NOT EXISTS roles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        description TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    await query(`CREATE TABLE IF NOT EXISTS employee_roles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER,
        role_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE CASCADE,
        FOREIGN KEY(role_id) REFERENCES roles(id) ON DELETE CASCADE,
        UNIQUE(employee_id, role_id)
    )`);

    await query(`CREATE TABLE IF NOT EXISTS punches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER,
        role_id INTEGER,
        punch_type TEXT CHECK(punch_type IN ('in','out','break_start','break_end')),
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        note TEXT,
        edited_by INTEGER,
        edited_at DATETIME,
        original_timestamp DATETIME,
        FOREIGN KEY(employee_id) REFERENCES employees(id),
        FOREIGN KEY(role_id) REFERENCES roles(id),
        FOREIGN KEY(edited_by) REFERENCES employees(id)
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

    await query(`ALTER TABLE employees ADD COLUMN pay_period TEXT DEFAULT 'weekly'`).catch(() => {});
    
    await seedRoles();
    await seedEmployees();
}

async function seedRoles() {
    const rows = await query('SELECT COUNT(*) as count FROM roles');
    const count = parseInt(rows[0].count || rows[0]['COUNT(*)'] || 0);
    if (count > 0) return;

    const defaultRoles = [
        ['Prep', 'Food preparation'],
        ['Cook', 'Line cook / kitchen'],
        ['Serving', 'Front of house service'],
        ['Dish', 'Dishwashing'],
        ['Bartender', 'Bar service'],
        ['Manager', 'Management']
    ];

    for (const [name, desc] of defaultRoles) {
        await query('INSERT INTO roles (name, description) VALUES (?,?)', [name, desc]);
    }
    console.log('✅ Default roles seeded');
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

    // Get role IDs
    const roles = await query('SELECT id, name FROM roles');
    const roleMap = {};
    roles.forEach(r => roleMap[r.name] = r.id);

    for (const [name, pin, rate, role] of employees) {
        const hashed = bcrypt.hashSync(pin, 10);
        const result = await query('INSERT INTO employees (name,pin,hourly_rate,role) VALUES (?,?,?,?)', [name, hashed, rate, role]);
        const empId = result[0]?.lastID || result[0]?.id;

        // Assign roles based on employee name
        if (name === 'Marline') {
            // Marline: Prep, Cook
            await assignEmployeeRole(empId, roleMap['Prep']);
            await assignEmployeeRole(empId, roleMap['Cook']);
        } else if (name === 'Kara') {
            // Kara: Prep, Dish, Serving
            await assignEmployeeRole(empId, roleMap['Prep']);
            await assignEmployeeRole(empId, roleMap['Dish']);
            await assignEmployeeRole(empId, roleMap['Serving']);
        } else if (name === 'Christopher') {
            // Christopher: Serving, Cooking, Prep, Dish
            await assignEmployeeRole(empId, roleMap['Serving']);
            await assignEmployeeRole(empId, roleMap['Cook']);
            await assignEmployeeRole(empId, roleMap['Prep']);
            await assignEmployeeRole(empId, roleMap['Dish']);
        } else if (name === 'Sarah') {
            // Sarah: Serving, Dish
            await assignEmployeeRole(empId, roleMap['Serving']);
            await assignEmployeeRole(empId, roleMap['Dish']);
        } else if (role === 'admin') {
            // Admin gets all roles
            for (const r of roles) {
                await assignEmployeeRole(empId, r.id);
            }
        } else {
            // Default for others: give them all common roles
            const commonRoles = ['Prep', 'Cook', 'Serving', 'Dish'];
            for (const rName of commonRoles) {
                if (roleMap[rName]) {
                    await assignEmployeeRole(empId, roleMap[rName]);
                }
            }
        }
    }
    console.log('✅ Employees seeded with role assignments');
}

async function assignEmployeeRole(employeeId, roleId) {
    if (!employeeId || !roleId) return;
    try {
        await query('INSERT OR IGNORE INTO employee_roles (employee_id, role_id) VALUES (?,?)', [employeeId, roleId]);
    } catch (err) {
        // PostgreSQL might need different syntax
        if (isPostgres) {
            await query('INSERT INTO employee_roles (employee_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [employeeId, roleId]);
        }
    }
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

function dateBetween(col) {
    if (isPostgres) return `DATE(${col}) BETWEEN ? AND ?`;
    return `date(${col}) BETWEEN ? AND ?`;
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
        `SELECT p.*, e.name as employee_name, e.hourly_rate, r.name as role_name 
         FROM punches p 
         JOIN employees e ON p.employee_id=e.id 
         LEFT JOIN roles r ON p.role_id=r.id
         WHERE ${dateBetween('p.timestamp')} ORDER BY e.name,p.timestamp`,
        [start, end]
    );
    const tips = await query(
        `SELECT t.*, e.name as employee_name FROM tips t JOIN employees e ON t.employee_id=e.id WHERE t.date BETWEEN ? AND ? ORDER BY e.name`,
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

        const allEmps = await query('SELECT id,name,role,hourly_rate,pay_period,active,created_at FROM employees ORDER BY name');
        const allPunches = await query('SELECT p.*, r.name as role_name FROM punches p LEFT JOIN roles r ON p.role_id=r.id ORDER BY timestamp');
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

        const stats = JSON.stringify({ employees: allEmps.length, punches: allPunches.length, tips: allTips.length });
        await query(`INSERT INTO backups (type, status, stats) VALUES (?,?,?)`, ['weekly_auto', 'success', stats]);
        console.log('✅ Weekly backup email sent to', REPORT_EMAIL);
    } catch (err) {
        console.error('Weekly backup failed:', err.message);
        await query(`INSERT INTO backups (type, status, stats) VALUES (?,?,?)`, ['weekly_auto', 'failed', JSON.stringify({ error: err.message })]).catch(() => {});
    }
}

// ═══════════════════════════════════════════
// GOOGLE DRIVE DAILY BACKUP
// ═══════════════════════════════════════════
async function uploadToDrive(filename, content, mimeType = 'application/json') {
    const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
    if (!SA_JSON || !FOLDER_ID) return { skipped: true, reason: 'Google Drive not configured' };

    try {
        const { google } = require('googleapis');
        const credentials = JSON.parse(SA_JSON);
        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/drive.file']
        });
        const drive = google.drive({ version: 'v3', auth });
        const { Readable } = require('stream');

        const existing = await drive.files.list({
            q: `name='${filename}' and '${FOLDER_ID}' in parents and trashed=false`,
            fields: 'files(id, name)'
        });

        const stream = Readable.from([Buffer.from(content)]);
        const meta = { name: filename, parents: existing.data.files.length ? undefined : [FOLDER_ID] };

        let result;
        if (existing.data.files.length > 0) {
            result = await drive.files.update({
                fileId: existing.data.files[0].id,
                requestBody: { name: filename },
                media: { mimeType, body: stream }
            });
        } else {
            result = await drive.files.create({
                requestBody: meta,
                media: { mimeType, body: stream },
                fields: 'id, name'
            });
        }
        console.log(`✅ Google Drive upload: ${filename}`);
        return { success: true, fileId: result.data.id, filename };
    } catch (err) {
        console.error('Google Drive upload failed:', err.message);
        return { success: false, error: err.message };
    }
}

async function runDailyDriveBackup() {
    const today = new Date().toISOString().split('T')[0];
    console.log(`Running daily Drive backup for ${today}...`);
    try {
        const allEmps = await query('SELECT id,name,role,hourly_rate,pay_period,active,created_at FROM employees ORDER BY name');
        const allPunches = await query('SELECT p.*, r.name as role_name FROM punches p LEFT JOIN roles r ON p.role_id=r.id ORDER BY timestamp');
        const allTips = await query('SELECT * FROM tips ORDER BY date');
        const fullBackup = JSON.stringify({
            exported: new Date().toISOString(),
            date: today,
            employees: allEmps,
            punches: allPunches,
            tips: allTips
        }, null, 2);

        const todayPunches = await query(
            `SELECT p.*, e.name as employee_name, e.hourly_rate, r.name as role_name 
             FROM punches p 
             JOIN employees e ON p.employee_id=e.id 
             LEFT JOIN roles r ON p.role_id=r.id
             WHERE ${dateBetween('p.timestamp')} ORDER BY e.name, p.timestamp`,
            [today, today]
        );
        const csvLines = ['Employee,Role,Type,Timestamp,Hourly Rate'];
        todayPunches.forEach(p => {
            csvLines.push(`"${p.employee_name}","${p.role_name || ''}","${p.punch_type}","${p.timestamp}","${p.hourly_rate}"`);
        });
        const todayCSV = csvLines.join('\n');

        const driveResult = await uploadToDrive(
            `woods-landing-fullbackup-${today}.json`,
            fullBackup,
            'application/json'
        );
        await uploadToDrive(
            `woods-landing-daily-${today}.csv`,
            todayCSV,
            'text/csv'
        );

        const stats = JSON.stringify({ employees: allEmps.length, punches: allPunches.length, tips: allTips.length, driveResult });
        await query(`INSERT INTO backups (type, status, stats) VALUES (?,?,?)`,
            ['daily_drive', driveResult.skipped ? 'skipped' : (driveResult.success ? 'success' : 'failed'), stats]
        ).catch(() => {});

        console.log(`✅ Daily Drive backup complete`);
    } catch (err) {
        console.error('Daily Drive backup failed:', err.message);
        await query(`INSERT INTO backups (type, status, stats) VALUES (?,?,?)`,
            ['daily_drive', 'failed', JSON.stringify({ error: err.message })]
        ).catch(() => {});
    }
}

// ═══════════════════════════════════════════
// UNIFIED SCHEDULER
// ═══════════════════════════════════════════
let lastDailyBackupDate = '';
let lastWeeklyBackupDate = '';

function startScheduler() {
    const tick = async () => {
        const now = new Date();
        const todayStr = now.toISOString().split('T')[0];
        const h = now.getHours();
        const min = now.getMinutes();

        if (h === 2 && min < 5 && lastDailyBackupDate !== todayStr) {
            lastDailyBackupDate = todayStr;
            await runDailyDriveBackup();
        }

        if (now.getDay() === 0 && h === 23 && min < 5 && lastWeeklyBackupDate !== todayStr) {
            lastWeeklyBackupDate = todayStr;
            await sendWeeklyBackup();
        }
    };

    setInterval(tick, 5 * 60 * 1000);
    console.log('✅ Scheduler running — daily Drive backup at 2am, weekly email Sundays 11pm');
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
            `SELECT p.*, r.name as role_name 
             FROM punches p 
             LEFT JOIN roles r ON p.role_id=r.id 
             WHERE p.employee_id=? AND DATE(p.timestamp)=${dateLocal()} 
             ORDER BY p.timestamp DESC LIMIT 1`,
            [req.session.employeeId]
        );
        res.json({ success: true, employeeName: req.session.employeeName, role: req.session.role, lastPunch: rows[0] || null });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ═══════════════════════════════════════════
// ROLES ROUTES
// ═══════════════════════════════════════════
app.get('/api/roles', async (req, res) => {
    try {
        const roles = await query('SELECT * FROM roles ORDER BY name');
        res.json({ success: true, roles });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/employee/:id/roles', async (req, res) => {
    if (!req.session.employeeId) return res.status(401).json({ success: false });
    // Employees can only see their own roles
    if (req.session.employeeId != req.params.id && req.session.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Access denied' });
    }
    try {
        const roles = await query(
            `SELECT r.* FROM roles r 
             JOIN employee_roles er ON r.id = er.role_id 
             WHERE er.employee_id = ? 
             ORDER BY r.name`,
            [req.params.id]
        );
        res.json({ success: true, roles });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ═══════════════════════════════════════════
// CLOCK ROUTES - Now with role selection
// ═══════════════════════════════════════════
app.post('/api/clock', async (req, res) => {
    if (!req.session.employeeId) return res.status(401).json({ success: false });
    const { type, roleId } = req.body;
    if (!['in','out','break_start','break_end'].includes(type)) return res.status(400).json({ success: false });
    
    // For clock in, role is required
    if (type === 'in' && !roleId) {
        return res.status(400).json({ success: false, message: 'Role selection required' });
    }
    
    try {
        await query('INSERT INTO punches (employee_id, role_id, punch_type) VALUES (?,?,?)', 
            [req.session.employeeId, roleId || null, type]);
        res.json({ success: true, type, timestamp: new Date().toISOString() });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ═══════════════════════════════════════════
// TIPS ROUTES
// ═══════════════════════════════════════════
app.post('/api/tips/report', async (req, res) => {
    if (!req.session.employeeId) return res.status(401).json({ success: false });
    const total = parseFloat(req.body.total_tips) || 0;
    const today = new Date().toISOString().split('T')[0];
    try {
        await query('DELETE FROM tips WHERE employee_id=? AND date=?', [req.session.employeeId, today]);
        await query('INSERT INTO tips (employee_id,date,total_tips) VALUES (?,?,?)', [req.session.employeeId, today, total]);
        res.json({ success: true, total });
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
// PUBLIC — employee list for PIN pad display
// ═══════════════════════════════════════════
app.get('/api/employees/list', async (req, res) => {
    try {
        const rows = await query("SELECT id, name, role FROM employees WHERE active=1 ORDER BY name");
        res.json({ success: true, employees: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ═══════════════════════════════════════════
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
        const empId = rows[0]?.lastID || rows[0]?.id;
        
        // Assign default roles (all common roles)
        const roles = await query('SELECT id FROM roles WHERE name IN (?,?,?,?)', ['Prep', 'Cook', 'Serving', 'Dish']);
        for (const r of roles) {
            await assignEmployeeRole(empId, r.id);
        }
        
        res.json({ success: true, id: empId });
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
// ADMIN — EMPLOYEE ROLES MANAGEMENT
// ═══════════════════════════════════════════
app.get('/api/admin/employee/:id/roles', requireAdmin, async (req, res) => {
    try {
        const assigned = await query(
            `SELECT r.* FROM roles r 
             JOIN employee_roles er ON r.id = er.role_id 
             WHERE er.employee_id = ? 
             ORDER BY r.name`,
            [req.params.id]
        );
        const allRoles = await query('SELECT * FROM roles ORDER BY name');
        res.json({ success: true, assigned, allRoles });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/admin/employee/:id/roles', requireAdmin, async (req, res) => {
    const { roleId } = req.body;
    if (!roleId) return res.status(400).json({ success: false });
    try {
        await assignEmployeeRole(req.params.id, roleId);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.delete('/api/admin/employee/:id/roles/:roleId', requireAdmin, async (req, res) => {
    try {
        await query('DELETE FROM employee_roles WHERE employee_id=? AND role_id=?', 
            [req.params.id, req.params.roleId]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ═══════════════════════════════════════════
// ADMIN — ROLES MANAGEMENT (Create new roles)
// ═══════════════════════════════════════════
app.post('/api/admin/roles', requireAdmin, async (req, res) => {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Role name required' });
    try {
        await query('INSERT INTO roles (name, description) VALUES (?,?)', [name, description || '']);
        res.json({ success: true });
    } catch (err) { 
        if (err.message.includes('UNIQUE') || err.code === '23505') {
            res.status(400).json({ success: false, message: 'Role already exists' });
        } else {
            res.status(500).json({ success: false, error: err.message });
        }
    }
});

// ═══════════════════════════════════════════
// ADMIN — PUNCH EDITING
// ═══════════════════════════════════════════
app.put('/api/admin/punches/:id', requireAdmin, async (req, res) => {
    const { timestamp, punch_type, roleId } = req.body;
    const punchId = req.params.id;
    
    try {
        // Get the original punch for audit trail
        const original = await query('SELECT * FROM punches WHERE id=?', [punchId]);
        if (!original.length) return res.status(404).json({ success: false, message: 'Punch not found' });
        
        // Update with audit info
        await query(
            `UPDATE punches SET 
                timestamp=?, 
                punch_type=?, 
                role_id=?,
                edited_by=?, 
                edited_at=CURRENT_TIMESTAMP,
                original_timestamp=COALESCE(original_timestamp, ?)
             WHERE id=?`,
            [timestamp, punch_type, roleId || null, req.session.employeeId, original[0].timestamp, punchId]
        );
        
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.delete('/api/admin/punches/:id', requireAdmin, async (req, res) => {
    try {
        await query('DELETE FROM punches WHERE id=?', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ═══════════════════════════════════════════
// ADMIN — EMPLOYEE PROFILE (updated with roles)
// ═══════════════════════════════════════════
app.get('/api/admin/employee/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { start, end } = req.query;
    try {
        const emps = await query('SELECT id,name,role,hourly_rate,pay_period,active,created_at FROM employees WHERE id=?', [id]);
        if (!emps.length) return res.status(404).json({ success: false, message: 'Not found' });
        const emp = emps[0];

        let punches, tips;
        if (start && end) {
            punches = await query(
                `SELECT p.*, r.name as role_name 
                 FROM punches p 
                 LEFT JOIN roles r ON p.role_id=r.id 
                 WHERE p.employee_id=? AND ${dateBetween('p.timestamp')} 
                 ORDER BY p.timestamp ASC`,
                [id, start, end]
            );
            tips = await query(
                `SELECT * FROM tips WHERE employee_id=? AND date BETWEEN ? AND ? ORDER BY date ASC`,
                [id, start, end]
            );
        } else {
            punches = await query(
                `SELECT p.*, r.name as role_name 
                 FROM punches p 
                 LEFT JOIN roles r ON p.role_id=r.id 
                 WHERE p.employee_id=? ORDER BY p.timestamp ASC`,
                [id]
            );
            tips = await query(`SELECT * FROM tips WHERE employee_id=? ORDER BY date ASC`, [id]);
        }

        // Get employee's assigned roles
        const assignedRoles = await query(
            `SELECT r.* FROM roles r 
             JOIN employee_roles er ON r.id = er.role_id 
             WHERE er.employee_id = ? 
             ORDER BY r.name`,
            [id]
        );

        const mins = calcMinutes(punches);
        const hours = mins / 60;
        const gross = hours * emp.hourly_rate;
        const totalTips = tips.reduce((s, t) => s + (t.total_tips || 0), 0);

        res.json({
            success: true, 
            employee: emp,
            stats: { totalHours: hours.toFixed(2), grossPay: gross.toFixed(2), totalTips: totalTips.toFixed(2) },
            punches, 
            tips,
            assignedRoles
        });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ═══════════════════════════════════════════
// ADMIN — REPORTS (updated with roles)
// ═══════════════════════════════════════════
app.get('/api/report/punches', requireAdmin, async (req, res) => {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ success: false });
    try {
        const rows = await query(
            `SELECT p.*, e.name as employee_name, e.hourly_rate, r.name as role_name 
             FROM punches p 
             JOIN employees e ON p.employee_id=e.id 
             LEFT JOIN roles r ON p.role_id=r.id 
             WHERE ${dateBetween('p.timestamp')} 
             ORDER BY e.name,p.timestamp`,
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
            `SELECT t.*, e.name as employee_name FROM tips t JOIN employees e ON t.employee_id=e.id WHERE t.date BETWEEN ? AND ? ORDER BY e.name,t.date`,
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
                `SELECT p.*, r.name as role_name 
                 FROM punches p 
                 LEFT JOIN roles r ON p.role_id=r.id 
                 WHERE employee_id=? AND ${dateBetween('timestamp')} 
                 ORDER BY timestamp`,
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
        const allPunches = await query('SELECT p.*, r.name as role_name FROM punches p LEFT JOIN roles r ON p.role_id=r.id ORDER BY timestamp');
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
// ADMIN — CSV EXPORT (updated with roles)
// ═══════════════════════════════════════════
app.get('/api/report/csv', requireAdmin, async (req, res) => {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ success: false, message: 'start and end required' });
    try {
        const punches = await query(
            `SELECT p.*, e.name as employee_name, e.hourly_rate, r.name as role_name 
             FROM punches p 
             JOIN employees e ON p.employee_id=e.id 
             LEFT JOIN roles r ON p.role_id=r.id 
             WHERE ${dateBetween('p.timestamp')} 
             ORDER BY e.name, p.timestamp`,
            [start, end]
        );
        const tips = await query(
            `SELECT t.*, e.name as employee_name FROM tips t JOIN employees e ON t.employee_id=e.id WHERE t.date BETWEEN ? AND ? ORDER BY e.name, t.date`,
            [start, end]
        );

        const empMap = {};
        punches.forEach(p => {
            if (!empMap[p.employee_name]) empMap[p.employee_name] = { punches: [], tips: 0, rate: p.hourly_rate };
            empMap[p.employee_name].punches.push(p);
        });
        tips.forEach(t => { if (empMap[t.employee_name]) empMap[t.employee_name].tips += parseFloat(t.total_tips || 0); });

        const lines = [];
        lines.push('WOODS LANDING TIME CLOCK REPORT');
        lines.push(`Period,${start},to,${end}`);
        lines.push(`Generated,${new Date().toLocaleString()}`);
        lines.push('');
        lines.push('EMPLOYEE SUMMARY');
        lines.push('Employee,Hours,Hourly Rate,Gross Pay,Tips,Total Earnings');
        let gh = 0, gp = 0, gt = 0;
        Object.entries(empMap).forEach(([name, d]) => {
            const mins = calcMinutes(d.punches);
            const h = Math.round(mins / 60 * 10000) / 10000;
            const pay = Math.round(h * d.rate * 100) / 100;
            const tips = Math.round(d.tips * 100) / 100;
            gh += h; gp += pay; gt += tips;
            lines.push(`"${name}",${h.toFixed(4)},${d.rate.toFixed(2)},${pay.toFixed(2)},${tips.toFixed(2)},${(pay + tips).toFixed(2)}`);
        });
        lines.push(`TOTALS,${gh.toFixed(4)},,${gp.toFixed(2)},${gt.toFixed(2)},${(gp + gt).toFixed(2)}`);
        lines.push('');

        lines.push('PUNCH DETAIL');
        lines.push('Employee,Role,Date,Time,Type');
        punches.forEach(p => {
            const dt = new Date(p.timestamp);
            lines.push(`"${p.employee_name}","${p.role_name || ''}","${dt.toLocaleDateString()}","${dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}","${p.punch_type === 'in' ? 'Clock In' : 'Clock Out'}"`);
        });
        lines.push('');

        lines.push('TIPS DETAIL');
        lines.push('Employee,Date,Tips');
        tips.forEach(t => {
            lines.push(`"${t.employee_name}","${t.date}",${parseFloat(t.total_tips || 0).toFixed(2)}`);
        });

        const csv = lines.join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="woods-landing-${start}-to-${end}.csv"`);
        res.send(csv);
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ═══════════════════════════════════════════
// ADMIN — DRIVE BACKUP & EMAIL
// ═══════════════════════════════════════════
app.post('/api/admin/drive-backup', requireAdmin, async (req, res) => {
    try {
        await runDailyDriveBackup();
        const SA = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
        const FID = process.env.GOOGLE_DRIVE_FOLDER_ID;
        if (!SA || !FID) return res.json({ success: false, skipped: true, reason: 'Google Drive not configured' });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

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
            await query(`INSERT INTO backups (type, status, stats) VALUES (?,?,?)`,
                ['manual_email', 'success', JSON.stringify({ startDate, endDate, sentTo: REPORT_EMAIL })]
            ).catch(() => {});
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
        startScheduler();
    });
}).catch(err => {
    console.error('Failed to start:', err);
    process.exit(1);
});