const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: process.env.SESSION_SECRET || 'restaurant-timeclock-secret-2024',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

// Database setup - use /tmp on Render (writable directory)
const DB_PATH = process.env.NODE_ENV === 'production'
    ? '/tmp/timeclock.db'
    : path.join(__dirname, 'timeclock.db');

const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('Database connection error:', err.message);
    } else {
        console.log('✅ Connected to SQLite database at', DB_PATH);
    }
});

// Initialize database
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS employees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        pin TEXT NOT NULL,
        role TEXT DEFAULT 'employee',
        hourly_rate REAL DEFAULT 15.00,
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS punches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER,
        punch_type TEXT CHECK(punch_type IN ('in', 'out', 'break_start', 'break_end')),
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        note TEXT,
        FOREIGN KEY(employee_id) REFERENCES employees(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS tips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER,
        date TEXT DEFAULT CURRENT_DATE,
        cash_tips REAL DEFAULT 0,
        credit_tips REAL DEFAULT 0,
        total_tips REAL DEFAULT 0,
        reported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(employee_id) REFERENCES employees(id)
    )`);

    // Seed default employees if none exist
    db.get("SELECT COUNT(*) as count FROM employees", (err, row) => {
        if (err || row.count > 0) return;

        const employees = [
            ['Marline',     '1111', 15.00, 'employee'],
            ['Aaron',       '2222', 15.00, 'employee'],
            ['Christopher', '3333', 15.00, 'employee'],
            ['Gigi',        '4444', 15.00, 'employee'],
            ['Natalie',     '5555', 15.00, 'employee'],
            ['Kara',        '6666', 15.00, 'employee'],
            ['Sarah',       '7777', 15.00, 'employee'],
            ['Nathan',      '8888', 15.00, 'employee'],
            ['Manager',     '1234', 25.00, 'admin']
        ];

        employees.forEach(([name, pin, rate, role]) => {
            const hashedPin = bcrypt.hashSync(pin, 10);
            db.run(
                "INSERT INTO employees (name, pin, hourly_rate, role) VALUES (?, ?, ?, ?)",
                [name, hashedPin, rate, role],
                (err) => { if (err) console.error('Seed error:', err.message); }
            );
        });
        console.log('✅ Default employees seeded');
    });
});

// ==================== API ENDPOINTS ====================

// Health check
app.get('/api/health', (req, res) => {
    res.json({ success: true, message: 'Server is running' });
});

// Login
app.post('/api/login', (req, res) => {
    const { pin } = req.body;
    if (!pin) return res.status(400).json({ success: false, message: 'PIN required' });

    db.all("SELECT * FROM employees WHERE active = 1", (err, employees) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (!employees || employees.length === 0) {
            return res.status(401).json({ success: false, message: 'No employees found' });
        }

        const employee = employees.find(e => bcrypt.compareSync(pin, e.pin));

        if (employee) {
            req.session.employeeId = employee.id;
            req.session.employeeName = employee.name;
            req.session.role = employee.role;
            res.json({
                success: true,
                employee: { id: employee.id, name: employee.name, role: employee.role }
            });
        } else {
            res.status(401).json({ success: false, message: 'Invalid PIN' });
        }
    });
});

// Logout
app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// Get current status
app.get('/api/status', (req, res) => {
    if (!req.session.employeeId) {
        return res.status(401).json({ success: false, message: 'Not logged in' });
    }

    db.get(
        `SELECT * FROM punches
         WHERE employee_id = ?
         AND date(timestamp) = date('now', 'localtime')
         ORDER BY timestamp DESC LIMIT 1`,
        [req.session.employeeId],
        (err, lastPunch) => {
            if (err) return res.status(500).json({ success: false, error: err.message });
            res.json({
                success: true,
                employeeId: req.session.employeeId,
                employeeName: req.session.employeeName,
                role: req.session.role,
                lastPunch: lastPunch || null,
                clockedIn: lastPunch ? lastPunch.punch_type === 'in' : false,
                onBreak: lastPunch ? lastPunch.punch_type === 'break_start' : false
            });
        }
    );
});

// Clock in/out/break
app.post('/api/clock', (req, res) => {
    if (!req.session.employeeId) {
        return res.status(401).json({ success: false, message: 'Not logged in' });
    }

    const { type } = req.body;
    const validTypes = ['in', 'out', 'break_start', 'break_end'];
    if (!validTypes.includes(type)) {
        return res.status(400).json({ success: false, message: 'Invalid punch type' });
    }

    db.run(
        "INSERT INTO punches (employee_id, punch_type) VALUES (?, ?)",
        [req.session.employeeId, type],
        function(err) {
            if (err) return res.status(500).json({ success: false, error: err.message });
            res.json({ success: true, id: this.lastID, type, timestamp: new Date().toISOString() });
        }
    );
});

// Get today's punch history for logged-in employee
app.get('/api/punches/today', (req, res) => {
    if (!req.session.employeeId) {
        return res.status(401).json({ success: false, message: 'Not logged in' });
    }

    db.all(
        `SELECT * FROM punches
         WHERE employee_id = ?
         AND date(timestamp) = date('now', 'localtime')
         ORDER BY timestamp ASC`,
        [req.session.employeeId],
        (err, punches) => {
            if (err) return res.status(500).json({ success: false, error: err.message });
            res.json({ success: true, punches: punches || [] });
        }
    );
});

// Report tips
app.post('/api/tips/report', (req, res) => {
    if (!req.session.employeeId) {
        return res.status(401).json({ success: false, message: 'Not logged in' });
    }

    const { cash_tips, credit_tips } = req.body;
    const today = new Date().toISOString().split('T')[0];
    const cashAmt = parseFloat(cash_tips) || 0;
    const creditAmt = parseFloat(credit_tips) || 0;
    const total = cashAmt + creditAmt;

    db.run(
        `INSERT INTO tips (employee_id, date, cash_tips, credit_tips, total_tips)
         VALUES (?, ?, ?, ?, ?)`,
        [req.session.employeeId, today, cashAmt, creditAmt, total],
        function(err) {
            if (err) return res.status(500).json({ success: false, error: err.message });
            res.json({ success: true, message: `Tips recorded: $${total.toFixed(2)}`, total });
        }
    );
});

// Get today's tips for logged-in employee
app.get('/api/tips/today', (req, res) => {
    if (!req.session.employeeId) {
        return res.status(401).json({ success: false, message: 'Not logged in' });
    }

    const today = new Date().toISOString().split('T')[0];

    db.get(
        `SELECT * FROM tips
         WHERE employee_id = ? AND date = ?
         ORDER BY reported_at DESC LIMIT 1`,
        [req.session.employeeId, today],
        (err, tip) => {
            if (err) return res.status(500).json({ success: false, error: err.message });
            res.json({ success: true, tip: tip || { cash_tips: 0, credit_tips: 0, total_tips: 0 } });
        }
    );
});

// ==================== ADMIN ENDPOINTS ====================

function requireAdmin(req, res, next) {
    if (!req.session.role || req.session.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Admin access required' });
    }
    next();
}

// Get all employees
app.get('/api/admin/employees', requireAdmin, (req, res) => {
    db.all("SELECT id, name, role, hourly_rate, active, created_at FROM employees ORDER BY name", (err, rows) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, employees: rows || [] });
    });
});

// Add employee
app.post('/api/admin/employees', requireAdmin, (req, res) => {
    const { name, pin, hourly_rate, role } = req.body;
    if (!name || !pin) return res.status(400).json({ success: false, message: 'Name and PIN required' });

    const hashedPin = bcrypt.hashSync(pin, 10);
    db.run(
        "INSERT INTO employees (name, pin, hourly_rate, role) VALUES (?, ?, ?, ?)",
        [name, hashedPin, parseFloat(hourly_rate) || 15.00, role || 'employee'],
        function(err) {
            if (err) return res.status(500).json({ success: false, error: err.message });
            res.json({ success: true, id: this.lastID });
        }
    );
});

// Update employee
app.put('/api/admin/employees/:id', requireAdmin, (req, res) => {
    const { name, hourly_rate, active, pin } = req.body;
    const { id } = req.params;

    if (pin) {
        const hashedPin = bcrypt.hashSync(pin, 10);
        db.run(
            "UPDATE employees SET name=?, hourly_rate=?, active=?, pin=? WHERE id=?",
            [name, parseFloat(hourly_rate), active, hashedPin, id],
            (err) => {
                if (err) return res.status(500).json({ success: false, error: err.message });
                res.json({ success: true });
            }
        );
    } else {
        db.run(
            "UPDATE employees SET name=?, hourly_rate=?, active=? WHERE id=?",
            [name, parseFloat(hourly_rate), active, id],
            (err) => {
                if (err) return res.status(500).json({ success: false, error: err.message });
                res.json({ success: true });
            }
        );
    }
});

// Punch report
app.get('/api/report/punches', requireAdmin, (req, res) => {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ success: false, message: 'start and end dates required' });

    db.all(
        `SELECT p.*, e.name as employee_name, e.hourly_rate
         FROM punches p
         JOIN employees e ON p.employee_id = e.id
         WHERE date(p.timestamp) BETWEEN ? AND ?
         ORDER BY e.name, p.timestamp`,
        [start, end],
        (err, punches) => {
            if (err) return res.status(500).json({ success: false, error: err.message });
            res.json({ success: true, punches: punches || [] });
        }
    );
});

// Tips report
app.get('/api/report/tips', requireAdmin, (req, res) => {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ success: false, message: 'start and end dates required' });

    db.all(
        `SELECT t.*, e.name as employee_name
         FROM tips t
         JOIN employees e ON t.employee_id = e.id
         WHERE t.date BETWEEN ? AND ?
         ORDER BY e.name, t.date`,
        [start, end],
        (err, tips) => {
            if (err) return res.status(500).json({ success: false, error: err.message });
            res.json({ success: true, tips: tips || [] });
        }
    );
});

// Hours summary report
app.get('/api/report/hours', requireAdmin, (req, res) => {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ success: false, message: 'start and end dates required' });

    db.all(
        `SELECT p.*, e.name as employee_name, e.hourly_rate
         FROM punches p
         JOIN employees e ON p.employee_id = e.id
         WHERE date(p.timestamp) BETWEEN ? AND ?
         ORDER BY e.name, p.timestamp`,
        [start, end],
        (err, punches) => {
            if (err) return res.status(500).json({ success: false, error: err.message });

            // Calculate hours per employee
            const summary = {};
            punches.forEach(p => {
                if (!summary[p.employee_name]) {
                    summary[p.employee_name] = {
                        employee_name: p.employee_name,
                        hourly_rate: p.hourly_rate,
                        total_minutes: 0,
                        clockInTime: null,
                        breakStartTime: null
                    };
                }
                const emp = summary[p.employee_name];
                const ts = new Date(p.timestamp);

                if (p.punch_type === 'in') emp.clockInTime = ts;
                else if (p.punch_type === 'break_start' && emp.clockInTime) {
                    emp.total_minutes += (ts - emp.clockInTime) / 60000;
                    emp.breakStartTime = ts;
                    emp.clockInTime = null;
                } else if (p.punch_type === 'break_end') {
                    emp.clockInTime = ts;
                } else if (p.punch_type === 'out' && emp.clockInTime) {
                    emp.total_minutes += (ts - emp.clockInTime) / 60000;
                    emp.clockInTime = null;
                }
            });

            const result = Object.values(summary).map(e => ({
                employee_name: e.employee_name,
                hourly_rate: e.hourly_rate,
                total_hours: (e.total_minutes / 60).toFixed(2),
                gross_pay: ((e.total_minutes / 60) * e.hourly_rate).toFixed(2)
            }));

            res.json({ success: true, summary: result });
        }
    );
});

// Catch-all: serve index.html for any non-API route
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
});
