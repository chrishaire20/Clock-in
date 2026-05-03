const express = require('express');
const session = require('express-session');
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

const WEBHOOK_URL = process.env.WEBHOOK_URL;
if (!WEBHOOK_URL) console.warn('⚠️  WEBHOOK_URL not set in Render environment variables');

async function callWebhook(action, payload = {}) {
    if (!WEBHOOK_URL) throw new Error('WEBHOOK_URL not configured — set it in Render env vars');
    const res = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...payload })
    });
    const result = await res.json();
    if (!result.success) throw new Error(result.data || 'Webhook error');
    return result.data;
}

let _empCache = [], _empCacheTime = 0;
const CACHE_TTL = 30000;

async function getEmployees(forceRefresh = false) {
    if (!forceRefresh && _empCacheTime && Date.now() - _empCacheTime < CACHE_TTL) return _empCache;
    _empCache = await callWebhook('employees');
    _empCacheTime = Date.now();
    return _empCache;
}

function requireAuth(req, res, next) {
    if (!req.session.employeeId) return res.status(401).json({ success: false });
    next();
}
function requireAdmin(req, res, next) {
    if (req.session.role !== 'admin') return res.status(403).json({ success: false, message: 'Admin only' });
    next();
}

app.get('/api/health', (req, res) => res.json({ success: true }));

app.post('/api/login', async (req, res) => {
    const { pin } = req.body;
    if (!pin) return res.status(400).json({ success: false, message: 'PIN required' });
    try {
        const employees = await getEmployees();
        const emp = employees.find(e => e.active && String(e.pin) === String(pin));
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

app.get('/api/status', requireAuth, async (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    try {
        const data = await callWebhook('status', { employeeId: req.session.employeeId, today });
        const employees = await getEmployees();
        const emp = employees.find(e => String(e.id) === String(req.session.employeeId));
        res.json({ success: true, employeeName: req.session.employeeName, role: req.session.role, lastPunch: data.lastPunch, canLogHours: emp ? !!emp.can_log_hours : true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/clock', requireAuth, async (req, res) => {
    const { type, work_role, role_rate } = req.body;
    if (!['in','out','break_start','break_end'].includes(type)) return res.status(400).json({ success: false });
    try {
        await callWebhook('punch', { employeeId: req.session.employeeId, timestamp: new Date().toISOString(), punch_type: type, work_role, role_rate });
        res.json({ success: true, type, timestamp: new Date().toISOString() });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/clock/manual', requireAuth, async (req, res) => {
    const { clock_in, clock_out, work_role, role_rate } = req.body;
    if (!clock_in || !clock_out) return res.status(400).json({ success: false });
    const employees = await getEmployees();
    const emp = employees.find(e => String(e.id) === String(req.session.employeeId));
    if (emp && !emp.can_log_hours) return res.status(403).json({ success: false, message: 'Hour logging not enabled for your account.' });
    const sevenDaysAgo = new Date(); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    if (new Date(clock_in) < sevenDaysAgo) return res.status(400).json({ success: false, message: 'You can only log shifts from the past 7 days.' });
    if (new Date(clock_out) <= new Date(clock_in)) return res.status(400).json({ success: false, message: 'Clock-out must be after clock-in.' });
    try {
        const data = await callWebhook('manualHours', { employeeId: req.session.employeeId, clock_in, clock_out, work_role, role_rate });
        res.json({ success: true, hours: data.hours });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/tips/report', requireAuth, async (req, res) => {
    const total = parseFloat(req.body.total_tips) || 0;
    try {
        await callWebhook('tip', { employeeId: req.session.employeeId, date: new Date().toISOString().split('T')[0], total_tips: total });
        res.json({ success: true, total });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/tips/today', requireAuth, async (req, res) => {
    try {
        const data = await callWebhook('getTipsToday', { employeeId: req.session.employeeId, today: new Date().toISOString().split('T')[0] });
        res.json({ success: true, tip: { total_tips: data.total_tips } });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/employees/list', async (req, res) => {
    try {
        const employees = await getEmployees();
        res.json({ success: true, employees: employees.filter(e => e.active).map(e => ({ id: e.id, name: e.name, role: e.role })) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/my-roles', requireAuth, async (req, res) => {
    try {
        const roles = await callWebhook('myRoles', { employeeId: req.session.employeeId });
        res.json({ success: true, roles });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/admin/employees', requireAdmin, async (req, res) => {
    try { res.json({ success: true, employees: await getEmployees(true) }); }
    catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/admin/employees', requireAdmin, async (req, res) => {
    const { name, pin, hourly_rate, role } = req.body;
    if (!name || !pin) return res.status(400).json({ success: false });
    try {
        const result = await callWebhook('addEmployee', { name, pin, hourly_rate, role });
        await getEmployees(true);
        res.json({ success: true, id: result.id });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.put('/api/admin/employees/:id', requireAdmin, async (req, res) => {
    try {
        await callWebhook('updateEmployee', { id: req.params.id, ...req.body });
        await getEmployees(true);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.patch('/api/admin/employees/:id/can-log-hours', requireAdmin, async (req, res) => {
    try {
        await callWebhook('updateEmployee', { id: req.params.id, can_log_hours: req.body.can_log_hours });
        await getEmployees(true);
        res.json({ success: true, can_log_hours: req.body.can_log_hours ? 1 : 0 });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/admin/employee/:id', requireAdmin, async (req, res) => {
    const { start, end } = req.query;
    try {
        const data = await callWebhook('getProfile', { employeeId: req.params.id, start, end });
        res.json({ success: true, ...data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/report/punches', requireAdmin, async (req, res) => {
    try { res.json({ success: true, punches: await callWebhook('getPunches', req.query) }); }
    catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/report/tips', requireAdmin, async (req, res) => {
    try { res.json({ success: true, tips: await callWebhook('getTips', req.query) }); }
    catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/report/tax', requireAdmin, async (req, res) => {
    try { res.json({ success: true, employees: await callWebhook('getTaxReport', req.query) }); }
    catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/report/csv', requireAdmin, async (req, res) => {
    const { start, end } = req.query;
    try {
        const [punches, tips] = await Promise.all([callWebhook('getPunches',{start,end}), callWebhook('getTips',{start,end})]);
        const empMap = {};
        punches.forEach(p => { if(!empMap[p.employee_name]) empMap[p.employee_name]={punches:[],tips:0,rate:p.hourly_rate}; empMap[p.employee_name].punches.push(p); });
        tips.forEach(t => { if(empMap[t.employee_name]) empMap[t.employee_name].tips+=(t.total_tips||0); });
        let lines=[`Woods Landing Report`,`${start} to ${end}`,``,`Employee,Hours,Gross,Tips,Total`], gh=0,gp=0,gt=0;
        Object.entries(empMap).forEach(([name,d])=>{
            let mins=0,lastIn=null,lastRate=d.rate;
            [...d.punches].sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp)).forEach(p=>{
                if(p.punch_type==='in'){lastIn=new Date(p.timestamp);lastRate=p.role_rate||d.rate;}
                else if(p.punch_type==='out'&&lastIn){mins+=(new Date(p.timestamp)-lastIn)/60000;lastIn=null;}
            });
            const h=mins/60,pay=h*lastRate; gh+=h;gp+=pay;gt+=d.tips;
            lines.push(`"${name}",${h.toFixed(2)},${pay.toFixed(2)},${d.tips.toFixed(2)},${(pay+d.tips).toFixed(2)}`);
        });
        lines.push(`TOTAL,${gh.toFixed(2)},${gp.toFixed(2)},${gt.toFixed(2)},${(gp+gt).toFixed(2)}`);
        res.setHeader('Content-Type','text/csv');
        res.setHeader('Content-Disposition',`attachment; filename="woods-landing-${start}-${end}.csv"`);
        res.send(lines.join('\n'));
    } catch(err){ res.status(500).json({success:false,error:err.message}); }
});

app.post('/api/admin/punches', requireAdmin, async (req, res) => {
    try { res.json({ success: true, ...(await callWebhook('addPunch', req.body)) }); }
    catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
app.put('/api/admin/punches/:id', requireAdmin, async (req, res) => {
    try { await callWebhook('editPunch', { id: req.params.id, ...req.body }); res.json({ success: true }); }
    catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
app.delete('/api/admin/punches/:id', requireAdmin, async (req, res) => {
    try { await callWebhook('deletePunch', { id: req.params.id }); res.json({ success: true }); }
    catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/admin/employee/:id/roles', requireAdmin, async (req, res) => {
    try { res.json({ success: true, roles: await callWebhook('getRoles', { employeeId: req.params.id }) }); }
    catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
app.post('/api/admin/employee/:id/roles', requireAdmin, async (req, res) => {
    try { res.json({ success: true, ...(await callWebhook('addRole', { employee_id: req.params.id, ...req.body })) }); }
    catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
app.put('/api/admin/employee/roles/:roleId', requireAdmin, async (req, res) => {
    try { await callWebhook('updateRole', { id: req.params.roleId, ...req.body }); res.json({ success: true }); }
    catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
app.delete('/api/admin/employee/roles/:roleId', requireAdmin, async (req, res) => {
    try { await callWebhook('deleteRole', { id: req.params.roleId }); res.json({ success: true }); }
    catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/admin/backup', requireAdmin, async (req, res) => {
    try {
        const [punches, tips, employees] = await Promise.all([callWebhook('getPunches',{start:'2000-01-01',end:'2099-12-31'}), callWebhook('getTips',{start:'2000-01-01',end:'2099-12-31'}), getEmployees()]);
        res.json({ success: true, backup: { employees, punches, tips }, stats: { employees: employees.length, punches: punches.length } });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
app.get('/api/admin/backups', requireAdmin, (req, res) => res.json({ success: true, backups: [] }));
app.post('/api/admin/reset-data', requireAdmin, async (req, res) => {
    if (req.body.confirm !== 'RESET') return res.status(400).json({ success: false, message: 'Must confirm with RESET' });
    try { await callWebhook('resetData', { keep_employees: req.body.keep_employees }); await getEmployees(true); res.json({ success: true, message: 'Data cleared.' }); }
    catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
app.post('/api/send-report', requireAdmin, (req, res) => res.json({ success: true, emailFailed: true, report: 'View your Google Sheet for full report data.' }));
app.post('/api/admin/drive-backup', requireAdmin, (req, res) => res.json({ success: true, skipped: true }));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Woods Landing on port ${PORT}${WEBHOOK_URL ? ' → ' + WEBHOOK_URL : ' (no webhook set)'}`);
});
