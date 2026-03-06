const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');

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

const DB_PATH = process.env.NODE_ENV === 'production'
    ? '/tmp/timeclock.db'
    : path.join(__dirname, 'timeclock.db');

const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) console.error('DB error:', err.message);
    else console.log('Connected to DB at', DB_PATH);
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS employees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        pin TEXT NOT NULL,
        role TEXT DEFAULT 'employee',
        hourly_rate REAL DEFAULT 15.00,
        pay_period TEXT DEFAULT 'weekly',
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`ALTER TABLE employees ADD COLUMN pay_period TEXT DEFAULT 'weekly'`, () => {});

    db.run(`CREATE TABLE IF NOT EXISTS punches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER,
        punch_type TEXT CHECK(punch_type IN ('in','out','break_start','break_end')),
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        note TEXT,
        FOREIGN KEY(employee_id) REFERENCES employees(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS tips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER,
        date TEXT DEFAULT CURRENT_DATE,
        total_tips REAL DEFAULT 0,
        reported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(employee_id) REFERENCES employees(id)
    )`);

    db.get("SELECT COUNT(*) as count FROM employees", (err, row) => {
        if (err || row.count > 0) return;
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
        employees.forEach(([name, pin, rate, role]) => {
            db.run("INSERT INTO employees (name,pin,hourly_rate,role) VALUES (?,?,?,?)", [name, bcrypt.hashSync(pin,10), rate, role]);
        });
        console.log('Employees seeded');
    });
});

function requireAdmin(req, res, next) {
    if (req.session.role !== 'admin') return res.status(403).json({ success: false, message: 'Admin only' });
    next();
}

function calcMinutes(punches) {
    let mins = 0, lastIn = null;
    [...punches].sort((a,b) => new Date(a.timestamp)-new Date(b.timestamp)).forEach(p => {
        if (p.punch_type === 'in') lastIn = new Date(p.timestamp);
        else if (p.punch_type === 'out' && lastIn) { mins += (new Date(p.timestamp)-lastIn)/60000; lastIn = null; }
    });
    return mins;
}

// AUTH
app.get('/api/health', (req, res) => res.json({ success: true }));

app.post('/api/login', (req, res) => {
    const { pin } = req.body;
    if (!pin) return res.status(400).json({ success: false, message: 'PIN required' });
    db.all("SELECT * FROM employees WHERE active=1", (err, employees) => {
        if (err) return res.status(500).json({ success: false });
        const emp = (employees||[]).find(e => bcrypt.compareSync(pin, e.pin));
        if (emp) {
            req.session.employeeId = emp.id;
            req.session.employeeName = emp.name;
            req.session.role = emp.role;
            res.json({ success: true, employee: { id: emp.id, name: emp.name, role: emp.role } });
        } else {
            res.status(401).json({ success: false, message: 'Invalid PIN' });
        }
    });
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

app.get('/api/status', (req, res) => {
    if (!req.session.employeeId) return res.status(401).json({ success: false });
    db.get(`SELECT * FROM punches WHERE employee_id=? AND date(timestamp)=date('now','localtime') ORDER BY timestamp DESC LIMIT 1`,
        [req.session.employeeId], (err, p) => res.json({ success: true, employeeName: req.session.employeeName, role: req.session.role, lastPunch: p||null }));
});

// CLOCK
app.post('/api/clock', (req, res) => {
    if (!req.session.employeeId) return res.status(401).json({ success: false });
    const { type } = req.body;
    if (!['in','out','break_start','break_end'].includes(type)) return res.status(400).json({ success: false });
    db.run("INSERT INTO punches (employee_id,punch_type) VALUES (?,?)", [req.session.employeeId, type], function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, id: this.lastID, type, timestamp: new Date().toISOString() });
    });
});

// TIPS
app.post('/api/tips/report', (req, res) => {
    if (!req.session.employeeId) return res.status(401).json({ success: false });
    const total = parseFloat(req.body.total_tips) || 0;
    const today = new Date().toISOString().split('T')[0];
    db.run(`DELETE FROM tips WHERE employee_id=? AND date=?`, [req.session.employeeId, today], () => {
        db.run(`INSERT INTO tips (employee_id,date,total_tips) VALUES (?,?,?)`, [req.session.employeeId, today, total], function(err) {
            if (err) return res.status(500).json({ success: false });
            res.json({ success: true, total });
        });
    });
});

app.get('/api/tips/today', (req, res) => {
    if (!req.session.employeeId) return res.status(401).json({ success: false });
    const today = new Date().toISOString().split('T')[0];
    db.get(`SELECT * FROM tips WHERE employee_id=? AND date=?`, [req.session.employeeId, today], (err, tip) => {
        res.json({ success: true, tip: tip || { total_tips: 0 } });
    });
});

// ADMIN - EMPLOYEES
app.get('/api/admin/employees', requireAdmin, (req, res) => {
    db.all("SELECT id,name,role,hourly_rate,pay_period,active,created_at FROM employees ORDER BY name", (err, rows) => {
        if (err) return res.status(500).json({ success: false });
        res.json({ success: true, employees: rows||[] });
    });
});

app.post('/api/admin/employees', requireAdmin, (req, res) => {
    const { name, pin, hourly_rate, role } = req.body;
    if (!name||!pin) return res.status(400).json({ success: false, message: 'Name and PIN required' });
    db.run("INSERT INTO employees (name,pin,hourly_rate,role) VALUES (?,?,?,?)",
        [name, bcrypt.hashSync(pin,10), parseFloat(hourly_rate)||15.00, role||'employee'],
        function(err) { if (err) return res.status(500).json({ success: false, error: err.message }); res.json({ success: true, id: this.lastID }); });
});

app.put('/api/admin/employees/:id', requireAdmin, (req, res) => {
    const { name, hourly_rate, active, pin, pay_period } = req.body;
    const pp = pay_period || 'weekly';
    if (pin) {
        db.run("UPDATE employees SET name=?,hourly_rate=?,active=?,pin=?,pay_period=? WHERE id=?",
            [name, parseFloat(hourly_rate), active, bcrypt.hashSync(pin,10), pp, req.params.id],
            (err) => { if (err) return res.status(500).json({ success: false }); res.json({ success: true }); });
    } else {
        db.run("UPDATE employees SET name=?,hourly_rate=?,active=?,pay_period=? WHERE id=?",
            [name, parseFloat(hourly_rate), active, pp, req.params.id],
            (err) => { if (err) return res.status(500).json({ success: false }); res.json({ success: true }); });
    }
});

// ADMIN - EMPLOYEE PROFILE
app.get('/api/admin/employee/:id', requireAdmin, (req, res) => {
    const { id } = req.params;
    const { start, end } = req.query;
    db.get("SELECT id,name,role,hourly_rate,pay_period,active,created_at FROM employees WHERE id=?", [id], (err, emp) => {
        if (!emp) return res.status(404).json({ success: false });
        const df = start && end ? `AND date(timestamp) BETWEEN '${start}' AND '${end}'` : '';
        const tf = start && end ? `AND date BETWEEN '${start}' AND '${end}'` : '';
        db.all(`SELECT * FROM punches WHERE employee_id=? ${df} ORDER BY timestamp ASC`, [id], (e1, punches) => {
            db.all(`SELECT * FROM tips WHERE employee_id=? ${tf} ORDER BY date ASC`, [id], (e2, tips) => {
                const mins = calcMinutes(punches||[]);
                const hours = mins/60;
                const gross = hours * emp.hourly_rate;
                const totalTips = (tips||[]).reduce((s,t)=>s+(t.total_tips||0),0);
                res.json({ success: true, employee: emp,
                    stats: { totalHours: hours.toFixed(2), grossPay: gross.toFixed(2), totalTips: totalTips.toFixed(2) },
                    punches: punches||[], tips: tips||[] });
            });
        });
    });
});

// ADMIN - SUMMARY REPORT
app.get('/api/report/summary', requireAdmin, (req, res) => {
    const { start, end } = req.query;
    if (!start||!end) return res.status(400).json({ success: false });
    db.all(`SELECT p.*,e.name as employee_name,e.hourly_rate FROM punches p JOIN employees e ON p.employee_id=e.id WHERE date(p.timestamp) BETWEEN ? AND ? ORDER BY e.name,p.timestamp`, [start,end], (e1, punches) => {
        db.all(`SELECT t.*,e.name as employee_name FROM tips t JOIN employees e ON t.employee_id=e.id WHERE t.date BETWEEN ? AND ? ORDER BY e.name`, [start,end], (e2, tips) => {
            const empData = {};
            (punches||[]).forEach(p => { if (!empData[p.employee_name]) empData[p.employee_name]={punches:[],hourly_rate:p.hourly_rate}; empData[p.employee_name].punches.push(p); });
            const tipsByEmp = {};
            (tips||[]).forEach(t => { tipsByEmp[t.employee_name]=(tipsByEmp[t.employee_name]||0)+(t.total_tips||0); });
            const summary = Object.entries(empData).map(([name, data]) => {
                const h = calcMinutes(data.punches)/60;
                return { name, hours: h.toFixed(2), hourly_rate: data.hourly_rate, gross_pay: (h*data.hourly_rate).toFixed(2), tips: (tipsByEmp[name]||0).toFixed(2) };
            });
            res.json({ success: true, summary });
        });
    });
});

app.get('/api/report/punches', requireAdmin, (req, res) => {
    const { start, end } = req.query;
    if (!start||!end) return res.status(400).json({ success: false });
    db.all(`SELECT p.*,e.name as employee_name,e.hourly_rate FROM punches p JOIN employees e ON p.employee_id=e.id WHERE date(p.timestamp) BETWEEN ? AND ? ORDER BY e.name,p.timestamp`,
        [start,end], (err,rows) => res.json({ success: true, punches: rows||[] }));
});

app.get('/api/report/tips', requireAdmin, (req, res) => {
    const { start, end } = req.query;
    if (!start||!end) return res.status(400).json({ success: false });
    db.all(`SELECT t.*,e.name as employee_name FROM tips t JOIN employees e ON t.employee_id=e.id WHERE t.date BETWEEN ? AND ? ORDER BY e.name,t.date`,
        [start,end], (err,rows) => res.json({ success: true, tips: rows||[] }));
});

// TAX / YEAR REPORT
app.get('/api/report/tax', requireAdmin, (req, res) => {
    const y = req.query.year || new Date().getFullYear();
    const start = `${y}-01-01`, end = `${y}-12-31`;
    db.all("SELECT id,name,hourly_rate FROM employees WHERE role='employee' ORDER BY name", (err, employees) => {
        if (err||!employees.length) return res.json({ success: true, year: y, employees: [] });
        let pending = employees.length;
        const results = [];
        employees.forEach(emp => {
            db.all(`SELECT * FROM punches WHERE employee_id=? AND date(timestamp) BETWEEN ? AND ? ORDER BY timestamp`, [emp.id,start,end], (e1,punches) => {
                db.all(`SELECT * FROM tips WHERE employee_id=? AND date BETWEEN ? AND ? ORDER BY date`, [emp.id,start,end], (e2,tips) => {
                    const mins = calcMinutes(punches||[]);
                    const hours = mins/60, gross = hours*emp.hourly_rate;
                    const totalTips = (tips||[]).reduce((s,t)=>s+(t.total_tips||0),0);
                    const monthly = {};
                    for (let m=1;m<=12;m++) monthly[m]={hours:0,gross:0,tips:0,mins:0};
                    const mPunches = {};
                    (punches||[]).forEach(p => { const m=new Date(p.timestamp).getMonth()+1; if(!mPunches[m]) mPunches[m]=[]; mPunches[m].push(p); });
                    Object.entries(mPunches).forEach(([m,ps]) => {
                        const mm=calcMinutes(ps); monthly[m].hours=(mm/60).toFixed(2); monthly[m].gross=((mm/60)*emp.hourly_rate).toFixed(2);
                    });
                    (tips||[]).forEach(t => { const m=new Date(t.date+'T00:00:00').getMonth()+1; monthly[m].tips=((parseFloat(monthly[m].tips)||0)+(t.total_tips||0)).toFixed(2); });
                    results.push({ id:emp.id, name:emp.name, hourly_rate:emp.hourly_rate,
                        total_hours:hours.toFixed(2), total_gross:gross.toFixed(2),
                        total_tips:totalTips.toFixed(2), total_earnings:(gross+totalTips).toFixed(2), monthly });
                    if (--pending===0) res.json({ success:true, year:y, employees:results.sort((a,b)=>a.name.localeCompare(b.name)) });
                });
            });
        });
    });
});

// EMAIL REPORT
app.post('/api/send-report', requireAdmin, async (req, res) => {
    const { startDate, endDate } = req.body;
    if (!startDate||!endDate) return res.status(400).json({ success: false });
    try {
        const getPunches = () => new Promise((resolve,reject) => db.all(`SELECT p.*,e.name as employee_name,e.hourly_rate FROM punches p JOIN employees e ON p.employee_id=e.id WHERE date(p.timestamp) BETWEEN ? AND ? ORDER BY e.name,p.timestamp`,[startDate,endDate],(err,r)=>err?reject(err):resolve(r||[])));
        const getTips    = () => new Promise((resolve,reject) => db.all(`SELECT t.*,e.name as employee_name FROM tips t JOIN employees e ON t.employee_id=e.id WHERE t.date BETWEEN ? AND ? ORDER BY e.name`,[startDate,endDate],(err,r)=>err?reject(err):resolve(r||[])));
        const [punches,tips] = await Promise.all([getPunches(),getTips()]);
        const empData={};
        punches.forEach(p=>{if(!empData[p.employee_name]) empData[p.employee_name]={punches:[],hourly_rate:p.hourly_rate}; empData[p.employee_name].punches.push(p);});
        const tipsByEmp={};
        tips.forEach(t=>{tipsByEmp[t.employee_name]=(tipsByEmp[t.employee_name]||0)+(t.total_tips||0);});
        let report=`WOODS LANDING TIME CLOCK REPORT\nPeriod: ${startDate} to ${endDate}\nGenerated: ${new Date().toLocaleString()}\n${'='.repeat(50)}\n\n`;
        let grandH=0,grandP=0,grandT=0;
        Object.entries(empData).forEach(([name,data])=>{
            const h=calcMinutes(data.punches)/60,p=h*data.hourly_rate,t=tipsByEmp[name]||0;
            grandH+=h;grandP+=p;grandT+=t;
            report+=`${name}\n  Hours: ${h.toFixed(2)} @ $${data.hourly_rate}/hr = $${p.toFixed(2)}\n  Tips: $${t.toFixed(2)}\n\n`;
        });
        report+=`${'='.repeat(50)}\nTOTALS\n  Hours: ${grandH.toFixed(2)}\n  Gross: $${grandP.toFixed(2)}\n  Tips: $${grandT.toFixed(2)}\n`;
        const {REPORT_EMAIL,EMAIL_USER,EMAIL_PASS}=process.env;
        if (REPORT_EMAIL&&EMAIL_USER&&EMAIL_PASS) {
            const nodemailer=require('nodemailer');
            const t=nodemailer.createTransport({service:'gmail',auth:{user:EMAIL_USER,pass:EMAIL_PASS}});
            await t.sendMail({from:EMAIL_USER,to:REPORT_EMAIL,subject:`Woods Landing Report: ${startDate} to ${endDate}`,text:report});
            res.json({ success:true, message:`Emailed to ${REPORT_EMAIL}` });
        } else {
            res.json({ success:true, emailFailed:true, report });
        }
    } catch(err) { res.status(500).json({ success:false, error:err.message }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));