const express = require('express');
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

// ============================================
// Google Apps Script Webhook URL
// ============================================
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://script.google.com/macros/s/AKfycbw1qPHhBLbQOMHj5PoD_4MxKxZMOwCDtv8MKkdoA-V0D1NaNhDSpvgFXraCrs1LDONV/exec';

// Helper: call webhook
async function callWebhook(action, payload) {
    const response = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...payload })
    });
    const result = await response.json();
    if (!result.success) throw new Error(result.data || 'Webhook error');
    return result.data;
}

// Cache employees in memory
let employeeCache = [];
let cacheTime = 0;
const CACHE_TTL = 60000; // 1 minute

async function getEmployees(refresh = false) {
    if (!refresh && cacheTime && Date.now() - cacheTime < CACHE_TTL) return employeeCache;
    const employees = await callWebhook('employees', {});
    employeeCache = employees;
    cacheTime = Date.now();
    return employees;
}

// Helper: get single employee by ID
async function getEmployeeById(id) {
    const employees = await getEmployees();
    return employees.find(e => e.id == id);
}

// ============================================
// ROUTES
// ============================================
app.get('/api/health', (req, res) => res.json({ success: true }));

app.post('/api/login', async (req, res) => {
    const { pin } = req.body;
    if (!pin) return res.status(400).json({ success: false, message: 'PIN required' });
    try {
        const employees = await getEmployees();
        const emp = employees.find(e => e.active && e.pin === pin); // plain PIN because webhook stores plain
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
    const today = new Date().toISOString().split('T')[0];
    try {
        const data = await callWebhook('status', { employeeId: req.session.employeeId, today });
        const emp = await getEmployeeById(req.session.employeeId);
        const canLogHours = emp ? emp.can_log_hours : true;
        res.json({
            success: true,
            employeeName: req.session.employeeName,
            role: req.session.role,
            lastPunch: data.lastPunch,
            canLogHours
        });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/clock', async (req, res) => {
    if (!req.session.employeeId) return res.status(401).json({ success: false });
    const { type, work_role, role_rate } = req.body;
    if (!['in','out','break_start','break_end'].includes(type)) return res.status(400).json({ success: false });
    const timestamp = new Date().toISOString();
    try {
        await callWebhook('punch', { employeeId: req.session.employeeId, timestamp, punch_type: type, work_role, role_rate });
        res.json({ success: true, type, timestamp });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/clock/manual', async (req, res) => {
    if (!req.session.employeeId) return res.status(401).json({ success: false });
    const { clock_in, clock_out, work_role, role_rate, note } = req.body;
    if (!clock_in || !clock_out) return res.status(400).json({ success: false });
    try {
        const data = await callWebhook('manualHours', { employeeId: req.session.employeeId, clock_in, clock_out, work_role, role_rate });
        res.json({ success: true, hours: data.hours });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/tips/report', async (req, res) => {
    if (!req.session.employeeId) return res.status(401).json({ success: false });
    const total = parseFloat(req.body.total_tips) || 0;
    const today = new Date().toISOString().split('T')[0];
    try {
        await callWebhook('tip', { employeeId: req.session.employeeId, date: today, total_tips: total });
        res.json({ success: true, total });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/tips/today', async (req, res) => {
    if (!req.session.employeeId) return res.status(401).json({ success: false });
    const today = new Date().toISOString().split('T')[0];
    try {
        const data = await callWebhook('getTipsToday', { employeeId: req.session.employeeId, today });
        res.json({ success: true, tip: { total_tips: data.total_tips } });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/employees/list', async (req, res) => {
    try {
        const employees = await getEmployees();
        const list = employees.filter(e => e.active).map(e => ({ id: e.id, name: e.name, role: e.role }));
        res.json({ success: true, employees: list });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/my-roles', async (req, res) => {
    if (!req.session.employeeId) return res.status(401).json({ success: false });
    try {
        const roles = await callWebhook('myRoles', { employeeId: req.session.employeeId });
        res.json({ success: true, roles });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ============================================
// ADMIN ROUTES (minimal for basic operation)
// ============================================
function requireAdmin(req, res, next) {
    if (req.session.role !== 'admin') return res.status(403).json({ success: false, message: 'Admin only' });
    next();
}

app.get('/api/admin/employees', requireAdmin, async (req, res) => {
    const employees = await getEmployees(true);
    res.json({ success: true, employees });
});

app.post('/api/admin/employees', requireAdmin, async (req, res) => {
    const { name, pin, hourly_rate, role } = req.body;
    if (!name || !pin) return res.status(400).json({ success: false });
    const result = await callWebhook('addEmployee', { name, pin, hourly_rate, role });
    await getEmployees(true); // refresh cache
    res.json({ success: true, id: result.id });
});

app.put('/api/admin/employees/:id', requireAdmin, async (req, res) => {
    const { name, hourly_rate, active, pin, pay_period, can_log_hours } = req.body;
    await callWebhook('updateEmployee', { id: req.params.id, name, hourly_rate, active, pin, can_log_hours });
    await getEmployees(true);
    res.json({ success: true });
});

app.patch('/api/admin/employees/:id/can-log-hours', requireAdmin, async (req, res) => {
    const val = req.body.can_log_hours;
    await callWebhook('updateEmployee', { id: req.params.id, can_log_hours: val });
    await getEmployees(true);
    res.json({ success: true });
});

// Simplified report endpoints (just return raw punches/tips from webhook – you can implement later)
app.get('/api/report/punches', requireAdmin, async (req, res) => {
    // For now return empty; you can expand webhook to fetch all punches
    res.json({ success: true, punches: [] });
});
app.get('/api/report/tips', requireAdmin, async (req, res) => {
    res.json({ success: true, tips: [] });
});
app.get('/api/admin/employee/:id', requireAdmin, async (req, res) => {
    const emp = await getEmployeeById(req.params.id);
    if (!emp) return res.status(404).json({ success: false });
    res.json({ success: true, employee: emp, stats: { totalHours: '0', grossPay: '0', totalTips: '0' }, punches: [], tips: [] });
});
app.post('/api/admin/backup', requireAdmin, (req, res) => res.json({ success: true, backup: {} }));
app.get('/api/admin/backups', requireAdmin, (req, res) => res.json({ success: true, backups: [] }));
app.post('/api/send-report', requireAdmin, (req, res) => res.json({ success: true, emailFailed: true, report: '' }));
app.post('/api/admin/drive-backup', requireAdmin, (req, res) => res.json({ success: true, skipped: true }));

// Serve frontend
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Woods Landing server running on port ${PORT} using Google Apps Script webhook`);
});