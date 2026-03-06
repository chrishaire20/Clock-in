const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const session = require('express-session');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const path = require('path');

const app = express();
const PORT = 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use(session({
    secret: 'restaurant-timeclock-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

// Database setup
const db = new sqlite3.Database('timeclock.db');

// Initialize database
db.serialize(() => {
    // Employees table
    db.run(`CREATE TABLE IF NOT EXISTS employees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        pin TEXT NOT NULL,
        role TEXT DEFAULT 'employee',
        hourly_rate REAL DEFAULT 15.00,
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Punches table
    db.run(`CREATE TABLE IF NOT EXISTS punches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER,
        punch_type TEXT CHECK(punch_type IN ('in', 'out', 'break_start', 'break_end')),
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        note TEXT,
        FOREIGN KEY(employee_id) REFERENCES employees(id)
    )`);

    // Tips table
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

    // Create default employees
    const employees = [
        ['Marline', '1111', 15.00],
        ['Aaron', '2222', 15.00],
        ['Christopher', '3333', 15.00],
        ['Gigi', '4444', 15.00],
        ['Natalie', '5555', 15.00],
        ['Kara', '6666', 15.00],
        ['Sarah', '7777', 15.00],
        ['Nathan', '8888', 15.00],
        ['Manager', '1234', 25.00, 'admin']
    ];

    employees.forEach(([name, pin, rate, role = 'employee']) => {
        db.get("SELECT * FROM employees WHERE name = ?", [name], (err, row) => {
            if (!row) {
                const hashedPin = bcrypt.hashSync(pin, 10);
                db.run(
                    "INSERT INTO employees (name, pin, hourly_rate, role) VALUES (?, ?, ?, ?)",
                    [name, hashedPin, rate, role]
                );
            }
        });
    });
});

// ==================== API ENDPOINTS ====================

// Login
app.post('/api/login', (req, res) => {
    const { pin } = req.body;
    
    db.all("SELECT * FROM employees WHERE active = 1", (err, employees) => {
        const employee = employees.find(e => bcrypt.compareSync(pin, e.pin));
        
        if (employee) {
            req.session.employeeId = employee.id;
            req.session.employeeName = employee.name;
            req.session.role = employee.role;
            res.json({ 
                success: true, 
                employee: { 
                    id: employee.id, 
                    name: employee.name, 
                    role: employee.role 
                } 
            });
        } else {
            res.status(401).json({ success: false, message: 'Invalid PIN' });
        }
    });
});

// Clock in/out
app.post('/api/clock', (req, res) => {
    if (!req.session.employeeId) {
        return res.status(401).json({ success: false, message: 'Not logged in' });
    }

    const { type } = req.body;
    
    db.run(
        "INSERT INTO punches (employee_id, punch_type) VALUES (?, ?)",
        [req.session.employeeId, type],
        function(err) {
            if (err) {
                res.status(500).json({ success: false, error: err.message });
            } else {
                res.json({ success: true, id: this.lastID });
            }
        }
    );
});

// Get status
app.get('/api/status', (req, res) => {
    if (!req.session.employeeId) {
        return res.status(401).json({ success: false, message: 'Not logged in' });
    }

    db.get(
        `SELECT * FROM punches 
         WHERE employee_id = ? 
         AND date(timestamp) = date('now')
         ORDER BY timestamp DESC LIMIT 1`,
        [req.session.employeeId],
        (err, lastPunch) => {
            res.json({
                success: true,
                employeeName: req.session.employeeName,
                lastPunch: lastPunch,
                clockedIn: lastPunch ? lastPunch.punch_type === 'in' : false
            });
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
    const total = (parseFloat(cash_tips) || 0) + (parseFloat(credit_tips) || 0);

    db.run(
        `INSERT INTO tips (employee_id, date, cash_tips, credit_tips, total_tips)
         VALUES (?, ?, ?, ?, ?)`,
        [req.session.employeeId, today, cash_tips || 0, credit_tips || 0, total],
        function(err) {
            if (err) {
                res.status(500).json({ success: false, error: err.message });
            } else {
                res.json({ success: true, message: `Tips recorded: $${total.toFixed(2)}` });
            }
        }
    );
});

// Get today's tips
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
            res.json({ success: true, tip: tip || { cash_tips: 0, credit_tips: 0, total_tips: 0 } });
        }
    );
});

// Report endpoints (admin only)
app.get('/api/report/punches', (req, res) => {
    if (!req.session.role || req.session.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Admin only' });
    }

    const { start, end } = req.query;
    
    db.all(
        `SELECT p.*, e.name as employee_name
         FROM punches p
         JOIN employees e ON p.employee_id = e.id
         WHERE date(p.timestamp) BETWEEN ? AND ?
         ORDER BY p.timestamp`,
        [start, end],
        (err, punches) => {
            res.json({ success: true, punches: punches || [] });
        }
    );
});

app.get('/api/report/tips', (req, res) => {
    if (!req.session.role || req.session.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Admin only' });
    }

    const { start, end } = req.query;
    
    db.all(
        `SELECT t.*, e.name as employee_name
         FROM tips t
         JOIN employees e ON t.employee_id = e.id
         WHERE date(t.reported_at) BETWEEN ? AND ?`,
        [start, end],
        (err, tips) => {
            res.json({ success: true, tips: tips || [] });
        }
    );
});

// Add employee (admin only)
app.post('/api/admin/employees', (req, res) => {
    if (!req.session.role || req.session.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Admin only' });
    }

    const { name, pin, hourly_rate } = req.body;
    const hashedPin = bcrypt.hashSync(pin, 10);

    db.run(
        "INSERT INTO employees (name, pin, hourly_rate) VALUES (?, ?, ?)",
        [name, hashedPin, hourly_rate],
        function(err) {
            if (err) {
                res.status(500).json({ success: false, error: err.message });
            } else {
                res.json({ success: true, id: this.lastID });
            }
        }
    );
});

// Email report
app.post('/api/send-report', async (req, res) => {
    const { startDate, endDate } = req.body;
    
    // For now, just return success (configure email later)
    res.json({ success: true, message: 'Report ready (email not configured)' });
});

// Logout
app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`👑 Manager PIN: 1234`);
    console.log(`🌐 Access URL will be provided by Render`);
});