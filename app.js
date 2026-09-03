require("dotenv").config();
console.log("🔍 APP.JS LOADED");
console.log("🔍 MYSQLHOST:", process.env.MYSQLHOST);
console.log("🔍 MYSQLPORT:", process.env.MYSQLPORT);
const express = require('express');
const path = require('path');
const db = require('./db');
const mysql = require("mysql2");
const expressLayouts = require('express-ejs-layouts');
const flash = require('connect-flash');
const bcrypt = require('bcryptjs');
// const { isAuthenticated } = require('./middleware/auth');
const app = express();
const multer = require("multer");
const csv = require("csv-parser");
const xlsx = require("xlsx");
const fs = require("fs");
const os = require('os');
const networkInterfaces = os.networkInterfaces();
const session = require('express-session');
const MemoryStore = require('memorystore')(session);
const ExcelJS = require('exceljs');
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('Trial Balance');
const upload = multer({ dest: "uploads/" });

function fmt(n) {
  return Math.round(Number(n || 0)).toLocaleString('en-PK');
}

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(session({
  secret: process.env.SESSION_SECRET || 'ledger_secret',
  resave: false,
  saveUninitialized: false,
  store: new MemoryStore({
    checkPeriod: 86400000 // 24 hours
  }),
  cookie: {
    secure: false,
    maxAge: 86400000
  }
}));
app.use(flash());
app.use((req, res, next) => {
  res.locals.success = req.flash('success');
  res.locals.error = req.flash('error');
  next();
});
app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  next();
});

// Default route → Login if not logged in
app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.redirect('/login');
});

// ===== LOGIN ROUTES =====
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('auth/login');
});

app.post('/login', async (req, res) => {
  const { company_code, username, password } = req.body;

  try {
    const [rows] = await db.query(
      'SELECT * FROM users WHERE username = ? AND company_code = ?',
      [username, company_code]
    );

    if (rows.length === 0) {
      req.flash('error', 'Invalid company, username, or password.');
      return res.redirect('/login');
    }

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password);

    if (!match) {
      req.flash('error', 'Invalid company, username, or password.');
      return res.redirect('/login');
    }

    // Login success ke baad, session set karne se pehle:
    const [[freshUser]] = await db.query(
      'SELECT session_version, company_role, permissions FROM users WHERE id = ?',
      [user.id]
    );

    // ✅ Store session with company info + RBAC
    req.session.user = {
      id:              user.id,
      username:        user.username,
      role:            user.role,
      company_code:    user.company_code,
      company_role:    freshUser?.company_role || 'user',
      session_version: freshUser?.session_version || 1,
      permissions:     freshUser?.permissions
        ? (typeof freshUser.permissions === 'string'
            ? JSON.parse(freshUser.permissions)
            : freshUser.permissions)
        : {}
    };

    await db.query('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);

    req.flash('success', `Welcome ${user.username}!`);
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Login error:', err);
    req.flash('error', 'Something went wrong. Try again.');
    res.redirect('/login');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// Middleware to allow only admin access
async function isAuthenticated(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }

  try {
    const companyCode = req.session.user.company_code;

    // 1) Company paused hai?
    const [[settings]] = await db.query(
      'SELECT is_paused, pause_message FROM company_settings WHERE company_code = ?',
      [companyCode]
    );

    if (settings?.is_paused) {
      const msg = settings.pause_message || 'Your account has been temporarily paused. Please contact support.';
      req.session.destroy(() => { });
      return res.render('paused', { message: msg, layout: false });
    }

    // 2) Force logout check
    if (req.session.user.session_version !== undefined) {
      const [[u]] = await db.query(
        'SELECT session_version FROM users WHERE id = ?',
        [req.session.user.id]
      );
      if (u && Number(u.session_version) !== Number(req.session.user.session_version)) {
        req.session.destroy(() => { });
        return res.redirect('/login');
      }
    }

    next();
  } catch (err) {
    console.error('isAuthenticated error:', err);
    next();
  }
}

function isAdmin(req, res, next) {
  if (req.session.user && req.session.user.role === 'admin') {
    return next();
  }
  req.flash('error', 'Access denied.');
  res.redirect('/dashboard');
}

// ✅ Missing tha — yeh add karna zaroori hai
async function logAdminAction(req, action, target) {
  try {
    await db.query(
      'INSERT INTO admin_logs (admin_username, action, target) VALUES (?, ?, ?)',
      [req.session.user.username, action, target]
    );
  } catch (err) {
    console.error('Admin log error:', err);
  }
}

// ===================== RBAC HELPERS =====================
function hasPermission(req, perm) {
  const user = req.session.user;
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.company_role === 'company_admin') return true;
  const perms = user.permissions || {};
  return !!perms[perm];
}

function requirePermission(perm) {
  return (req, res, next) => {
    if (hasPermission(req, perm)) return next();
    req.flash('error', 'You do not have permission to access this.');
    return res.redirect('/dashboard');
  };
}

// ===================== FEATURES MIDDLEWARE =====================
async function loadFeatures(req, res, next) {
  try {
    if (req.session.user) {
      const companyCode = req.session.user.company_code;
      const [rows] = await db.query(
        'SELECT feature_key, enabled FROM company_features WHERE company_code = ?',
        [companyCode]
      );
      const features = {};
      rows.forEach(r => { features[r.feature_key] = !!r.enabled; });
      req.features = features;
      res.locals.features = features;
    } else {
      req.features = {};
      res.locals.features = {};
    }
    next();
  } catch (err) {
    req.features = {};
    res.locals.features = {};
    next();
  }
}

app.use(expressLayouts);
app.set('layout', 'layout');
app.use(loadFeatures);

// ========== USER MANAGEMENT (Admin Only) ==========
app.get('/users', isAuthenticated, isAdmin, async (req, res) => {
  try {
    // Users — last_login aur created_at bhi
    const [users] = await db.query(`
      SELECT id, username, role, company_code, last_login, created_at 
      FROM users 
      ORDER BY company_code, username
    `);

    // ✅ Companies — pause_message, paused_at, user_count sab ke saath
    const [companies] = await db.query(`
      SELECT 
        cs.company_code,
        cs.is_paused,
        cs.pause_message,
        cs.paused_at,
        COUNT(u.id) AS user_count
      FROM company_settings cs
      LEFT JOIN users u ON u.company_code = cs.company_code
      GROUP BY cs.company_code, cs.is_paused, cs.pause_message, cs.paused_at
      ORDER BY cs.company_code
    `);

    // Stats
    const stats = {
      totalCompanies: companies.length,
      activeCompanies: companies.filter(c => !c.is_paused).length,
      pausedCompanies: companies.filter(c => c.is_paused).length,
      totalUsers: users.length
    };

    // ✅ Recent activity log
    const [recentLogs] = await db.query(
      'SELECT * FROM admin_logs ORDER BY created_at DESC LIMIT 20'
    );

    res.render('users', {
      users,
      companies,
      stats,
      recentLogs,
      error: req.flash('error'),
      success: req.flash('success')
    });

  } catch (err) {
    console.error('Fetch users error:', err);
    req.flash('error', 'Failed to load users.');
    res.redirect('/dashboard');
  }
});

// Add User
app.post('/users/add', isAuthenticated, isAdmin, async (req, res) => {
  const { company_code, username, password, role } = req.body;

  try {
    const [[companyExists]] = await db.query(
      "SELECT company_code FROM users WHERE company_code = ? LIMIT 1",
      [company_code]
    );

    const hashedPassword = await bcrypt.hash(password, 10);

    // ✅ role='admin' in form = company_admin, NOT software admin
    const actualCompanyRole = role === 'admin' ? 'company_admin' : 'user';

    await db.query(
      'INSERT INTO users (company_code, username, password, role, company_role) VALUES (?, ?, ?, ?, ?)',
      [company_code, username, hashedPassword, 'user', actualCompanyRole]
    );

    if (!companyExists) {
      const DEFAULT_GROUPS = [
        { code: '0111', name: 'Mills / Buyers Accounts' },
        { code: '0121', name: 'Seller Party Accounts' },
        { code: '0141', name: 'Net General Income' },
        { code: '0151', name: 'Cash At Bank & In Hand' },
        { code: '0161', name: 'Misc Payable & Receivable' },
        { code: '0171', name: 'Expenses Accounts' },
        { code: '0181', name: 'Investment / Outstanding' },
        { code: '0191', name: 'Capital Accounts' }
      ];

      for (const g of DEFAULT_GROUPS) {
        await db.query(
          "INSERT INTO `groups` (group_code, name, company_code) VALUES (?, ?, ?)",
          [g.code, g.name, company_code]
        );
      }

      await db.query(`
        INSERT INTO company_settings 
        (company_code, cash_account_code, voucher_prefix_receipt, voucher_prefix_payment, financial_year_start, financial_year_end)
        VALUES (?, '', '', '', '', '')
      `, [company_code]);
    }

    await logAdminAction(req, 'Added user', `${username} (${company_code})`);
    req.flash('success', 'New user created successfully!');
  } catch (err) {
    console.error('Add user error:', err);
    req.flash('error', 'Failed to add user. Maybe username already exists.');
  }

  res.redirect('/users');
});
 
// Edit User
app.post('/users/edit/:id', isAuthenticated, isAdmin, async (req, res) => {
  const { company_code, username, password, role } = req.body;

  try {
    if (password) {
      const hashedPassword = await bcrypt.hash(password, 10);
      await db.query(
        'UPDATE users SET company_code = ?, username = ?, password = ?, role = ? WHERE id = ?',
        [company_code, username, hashedPassword, role, req.params.id]
      );
    } else {
      await db.query(
        'UPDATE users SET company_code = ?, username = ?, role = ? WHERE id = ?',
        [company_code, username, role, req.params.id]
      );
    }
    await logAdminAction(req, 'Edited user', `${username} (${company_code})`);
    req.flash('success', 'User updated successfully.');
  } catch (err) {
    console.error('Edit user error:', err);
    req.flash('error', 'Failed to update user.');
  }
  res.redirect('/users');
});

// Delete User
app.post('/users/delete/:id', isAuthenticated, isAdmin, async (req, res) => {
  try {
    await db.query('DELETE FROM users WHERE id = ?', [req.params.id]);
    await logAdminAction(req, 'Deleted user', `User ID ${req.params.id}`);
    req.flash('success', 'User deleted successfully.');
  } catch (err) {
    console.error('Delete user error:', err);
    req.flash('error', 'Could not delete user.');
  }
  res.redirect('/users');
});

// Pause Company
app.post('/company/pause', isAuthenticated, isAdmin, async (req, res) => {
  const { company_code, message } = req.body;
  try {
    await db.query(
      `UPDATE company_settings 
       SET is_paused = 1, pause_message = ?, paused_at = NOW() 
       WHERE company_code = ?`,
      [message || 'Your account has been paused. Please contact support.', company_code]
    );
    await logAdminAction(req, 'Paused company', company_code);
    req.flash('success', `Company ${company_code} paused.`);
  } catch (err) {
    console.error('Pause error:', err);
    req.flash('error', 'Failed to pause company.');
  }
  res.redirect('/users');
});

// Resume Company
app.post('/company/resume', isAuthenticated, isAdmin, async (req, res) => {
  const { company_code } = req.body;
  try {
    await db.query(
      `UPDATE company_settings SET is_paused = 0, paused_at = NULL WHERE company_code = ?`,
      [company_code]
    );
    await logAdminAction(req, 'Resumed company', company_code);
    req.flash('success', `Company ${company_code} resumed.`);
  } catch (err) {
    console.error('Resume error:', err);
    req.flash('error', 'Failed to resume company.');
  }
  res.redirect('/users');
});

// Force logout
app.post('/users/force-logout/:id', isAuthenticated, isAdmin, async (req, res) => {
  try {
    await db.query(
      'UPDATE users SET session_version = session_version + 1 WHERE id = ?',
      [req.params.id]
    );
    await logAdminAction(req, 'Force logged out user', `User ID ${req.params.id}`);
    req.flash('success', 'User logged out from all devices.');
  } catch (err) {
    console.error('Force logout error:', err);
    req.flash('error', 'Failed to force logout.');
  }
  res.redirect('/users');
});

// ====== COMPANY SETUP ======
app.get('/setup/settings', isAuthenticated, async (req, res) => {
  const companyCode = req.session.user.company_code;
  const [settings] = await db.query('SELECT * FROM company_settings WHERE company_code = ?', [companyCode]);

  res.render('setup/settings', {
    settings: settings[0] || {},
    messages: {
      error: req.flash('error'),
      success: req.flash('success')
    }
  });
});

app.post('/setup/settings', isAuthenticated, async (req, res) => {
  const companyCode = req.session.user.company_code;
  let {
    cash_account_code,
    voucher_prefix_receipt,
    voucher_prefix_payment,
    financial_year_start,
    financial_year_end
  } = req.body;

  // Allow empty prefix
  voucher_prefix_receipt = voucher_prefix_receipt || "";
  voucher_prefix_payment = voucher_prefix_payment || "";

  const [exists] = await db.query(
    'SELECT * FROM company_settings WHERE company_code = ?',
    [companyCode]
  );

  if (exists.length > 0) {
    await db.query(`
      UPDATE company_settings 
      SET cash_account_code=?, voucher_prefix_receipt=?, voucher_prefix_payment=?,
          financial_year_start=?, financial_year_end=?
      WHERE company_code=?`,
      [
        cash_account_code,
        voucher_prefix_receipt,
        voucher_prefix_payment,
        financial_year_start,
        financial_year_end,
        companyCode
      ]
    );
  } else {
    await db.query(`
      INSERT INTO company_settings 
      (company_code, cash_account_code, voucher_prefix_receipt, voucher_prefix_payment, financial_year_start, financial_year_end)
      VALUES (?, ?, ?, ?, ?, ?)`,
      [
        companyCode,
        cash_account_code,
        voucher_prefix_receipt,
        voucher_prefix_payment,
        financial_year_start,
        financial_year_end
      ]
    );
  }

  req.flash('success', 'Company settings updated successfully!');
  res.redirect('/setup/settings');
});

app.post("/setup/import-data", upload.single("dataFile"), async (req, res) => {
  let conn;
  try {
    const filePath = req.file.path;
    const companyCode = req.session.user.company_code;
    const importType = req.body.import_type;

    const workbook = xlsx.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });

    let accountCount = 0;
    let txnCount = 0;
    let skippedCount = 0;

    const [[settings]] = await db.query(
      "SELECT cash_account_code FROM company_settings WHERE company_code = ?",
      [companyCode]
    );
    const CASH = settings?.cash_account_code;
    if (!CASH) throw new Error("Cash account not set in company settings");

    conn = await db.getConnection();
    await conn.beginTransaction();

    /* ================= ACCOUNT IMPORT ================= */
    if (importType === "account") {

      // ✅ Saare groups ek baar load karo
      const [allGroups] = await conn.query(
        "SELECT id, group_code FROM `groups` WHERE company_code = ?",
        [companyCode]
      );
      const groupMap = {};
      allGroups.forEach(g => { groupMap[g.group_code] = g.id; });

      // ✅ Batch insert values
      const insertValues = [];

      for (const row of rows) {
        const code_raw = row.code || row.account_code || row.Code;
        if (!code_raw) { skippedCount++; continue; }

        const full_code = String(code_raw).trim();
        if (full_code.length < 5 || !/^\d+$/.test(full_code)) { skippedCount++; continue; }

        const group_code = full_code.slice(0, 4);
        const group_id = groupMap[group_code];
        if (!group_id) { skippedCount++; continue; }

        const name = (row.name || row.Name || "").toString().trim() || full_code;
        const opening_balance = Number(row.opening_balance || row.Opening_Balance || 0);

        insertValues.push([group_id, full_code, name, opening_balance, companyCode]);
        accountCount++;
      }

      // ✅ Single batch insert
      if (insertValues.length > 0) {
        await conn.query(`
          INSERT INTO accounts (group_id, account_code, name, opening_balance, company_code)
          VALUES ?
          ON DUPLICATE KEY UPDATE
            name = VALUES(name),
            opening_balance = VALUES(opening_balance),
            group_id = VALUES(group_id)
        `, [insertValues]);
      }
    }

    /* ================= TRANSACTION IMPORT ================= */
    if (importType === "transaction") {

      // ✅ Groups aur accounts load karo
      const [allGroups] = await conn.query(
        "SELECT id, group_code FROM `groups` WHERE company_code = ?",
        [companyCode]
      );
      const groupMap = {};
      allGroups.forEach(g => { groupMap[g.group_code] = g.id; });

      const [allAccounts] = await conn.query(
        "SELECT id, account_code FROM accounts WHERE company_code = ?",
        [companyCode]
      );
      const accountSet = new Set(allAccounts.map(a => String(a.account_code).trim()));

      // ✅ Auto-create missing accounts
      const autoCreateMap = {};
      const txnRows = rows.filter(r => r.account_code && r.voucher_no);

      for (const row of txnRows) {
        const ac = String(row.account_code).trim();
        if (!accountSet.has(ac)) {
          const gc = ac.slice(0, 4);
          if (groupMap[gc]) autoCreateMap[ac] = groupMap[gc];
        }
        const cc = row.cash_code ? String(row.cash_code).trim() : null;
        if (cc && !accountSet.has(cc)) {
          const gc = cc.slice(0, 4);
          if (groupMap[gc]) autoCreateMap[cc] = groupMap[gc];
        }
      }

      if (Object.keys(autoCreateMap).length > 0) {
        const autoVals = Object.entries(autoCreateMap).map(([code, gid]) => [gid, code, code, 0, companyCode]);
        await conn.query(`
      INSERT INTO accounts (group_id, account_code, name, opening_balance, company_code)
      VALUES ?
      ON DUPLICATE KEY UPDATE account_code = account_code
    `, [autoVals]);
        Object.keys(autoCreateMap).forEach(c => accountSet.add(c));
      }

      // ✅ FIX: Import mein aane wale tamam voucher_no collect karo
      const incomingVoucherNos = [...new Set(
        txnRows
          .map(r => r.voucher_no?.toString().trim())
          .filter(Boolean)
      )];

      // ✅ FIX: Un voucher_nos ke existing transactions delete karo
      // — yeh "overwrite" ka kaam karta hai
      if (incomingVoucherNos.length > 0) {
        // MySQL IN() ki limit ke liye 500 ka batch
        const VBATCH = 500;
        for (let i = 0; i < incomingVoucherNos.length; i += VBATCH) {
          const slice = incomingVoucherNos.slice(i, i + VBATCH);
          await conn.query(
            `DELETE FROM transactions
         WHERE company_code = ? AND voucher_no IN (?)`,
            [companyCode, slice]
          );
        }
      }

      // ✅ Ab fresh insert karo
      const partyInserts = [];
      const cashInserts = [];

      function parseDDMMYYYY(val) {
        if (!val) return null;
        if (typeof val === "number") {
          const d = xlsx.SSF.parse_date_code(val);
          if (!d) return null;
          return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
        }
        if (typeof val === "string" && val.includes("/")) {
          const [dd, mm, yy] = val.split("/");
          if (!dd || !mm || !yy) return null;
          const year = yy.length === 2 ? (Number(yy) > 50 ? "19" + yy : "20" + yy) : yy;
          return `${year}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
        }
        if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
        return null;
      }

      for (const row of txnRows) {
        const trxDate = parseDDMMYYYY(row.date);
        if (!trxDate) { skippedCount++; continue; }

        const entry_type = (row.type || "CB").toString().trim();
        const vt_raw = (row.voucher_type || "").toString().trim().toUpperCase().replace(/\s+/g, '');
        const voucher_type = ["RV", "PV"].includes(vt_raw) ? vt_raw : "RV";
        const voucher_no = row.voucher_no.toString().trim();
        const serial_no = row.serial_no ? parseInt(row.serial_no) : 1;
        const account_code = row.account_code.toString().trim();
        const debit = Number(row.debit || 0);
        const credit = Number(row.credit || 0);
        const description = row.description || null;
        const reference = row.reference || null;
        const invoice = row.invoice || null;

        if (!accountSet.has(account_code)) { skippedCount++; continue; }

        let cashCode = row.cash_code ? row.cash_code.toString().trim() : CASH;
        if (!accountSet.has(cashCode)) cashCode = CASH;

        partyInserts.push([
          entry_type, voucher_type, trxDate, voucher_no, serial_no,
          account_code, debit, credit, description, reference, invoice, companyCode
        ]);
        cashInserts.push([
          entry_type, voucher_type, trxDate, voucher_no, serial_no,
          cashCode, credit, debit, description, reference, invoice, companyCode
        ]);

        txnCount += 2;
      }

      // ✅ Batch insert (500 at a time)
      const BATCH = 500;
      for (let i = 0; i < partyInserts.length; i += BATCH) {
        const pSlice = partyInserts.slice(i, i + BATCH);
        const cSlice = cashInserts.slice(i, i + BATCH);
        await conn.query(`
      INSERT INTO transactions
        (entry_type, voucher_type, date, voucher_no, serial_no,
         account_code, debit, credit, description, reference, invoice, company_code)
      VALUES ?
    `, [pSlice]);
        await conn.query(`
      INSERT INTO transactions
        (entry_type, voucher_type, date, voucher_no, serial_no,
         account_code, debit, credit, description, reference, invoice, company_code)
      VALUES ?
    `, [cSlice]);
      }
    }

    await conn.commit();
    conn.release();
    fs.unlinkSync(filePath);

    const [settingsData] = await db.query(
      'SELECT * FROM company_settings WHERE company_code = ?', [companyCode]
    );

    const total = accountCount + txnCount;
    const successMsg = total > 0
      ? `✅ Import successful! ${accountCount} accounts, ${txnCount / 2} transactions imported.${skippedCount > 0 ? ` (${skippedCount} rows skipped)` : ''}`
      : null;
    const errorMsg = total === 0
      ? `❌ No data imported! ${skippedCount} rows skipped — check column names.`
      : null;

    return res.render('setup/settings', {
      settings: settingsData[0] || {},
      messages: {
        success: successMsg ? [successMsg] : [],
        error: errorMsg ? [errorMsg] : []
      }
    });

  } catch (err) {
    console.error("IMPORT ERROR:", err);
    try { if (conn) { await conn.rollback(); conn.release(); } } catch (e) { }
    try { if (req.file?.path) fs.unlinkSync(req.file.path); } catch (e) { }

    const [settingsData] = await db.query(
      'SELECT * FROM company_settings WHERE company_code = ?',
      [req.session.user.company_code]
    ).catch(() => [[]]);

    return res.render('setup/settings', {
      settings: settingsData[0] || {},
      messages: { success: [], error: [`❌ Import failed: ${err.message}`] }
    });
  }
});

app.get('/gl/groups', isAuthenticated, requirePermission('accounts_manage'), async (req, res) => {
  const companyCode = req.session.user.company_code;

  const [groups] = await db.query(
    "SELECT * FROM `groups` WHERE company_code=? ORDER BY group_code",
    [companyCode]
  );

  res.render('gl/groups', { groups });
});

// ===== Add Group =====

app.get('/gl/add-group', (req, res) => res.redirect('/gl/groups'));

app.post('/gl/add-group', isAuthenticated, async (req, res) => {
  const { group_code, name } = req.body;
  const companyCode = req.session.user.company_code;

  // 3 ya 4 digit allow karo, leading zeros se 4 digit banao
  if (!/^\d{3,4}$/.test(group_code)) {
    req.flash('error', 'Group code must be 3 or 4 digits');
    return res.redirect('/gl/groups');
  }

  const paddedGroupCode = group_code.padStart(4, '0'); // 👈 3 digit ho to 0 aage

  const [[exists]] = await db.query(
    "SELECT id FROM `groups` WHERE group_code=? AND company_code=?",
    [paddedGroupCode, companyCode]
  );

  if (exists) {
    req.flash('error', 'Group already exists');
    return res.redirect('/gl/groups');
  }

  await db.query(
    "INSERT INTO `groups` (group_code, name, company_code) VALUES (?, ?, ?)",
    [paddedGroupCode, name, companyCode]
  );

  req.flash('success', 'Group added');
  res.redirect('/gl/groups');
});

app.post('/gl/update-group/:id', isAuthenticated, async (req, res) => {
  const { name } = req.body;

  await db.query(
    "UPDATE `groups` SET name=? WHERE id=?",
    [name, req.params.id]
  );

  req.flash('success', 'Group updated');
  res.redirect('/gl/groups');
});

app.post('/gl/delete-group/:id', isAuthenticated, async (req, res) => {
  const companyCode = req.session.user.company_code;

  const [[acc]] = await db.query(
    "SELECT id FROM accounts WHERE group_id=? AND company_code=?",
    [req.params.id, companyCode]
  );

  if (acc) {
    req.flash('error', 'Group has accounts');
    return res.redirect('/gl/groups');
  }

  await db.query(
    "DELETE FROM `groups` WHERE id=? AND company_code=?",
    [req.params.id, companyCode]
  );

  req.flash('success', 'Group deleted');
  res.redirect('/gl/groups');
});

// Accounts     
app.get('/gl/accounts', isAuthenticated, requirePermission('accounts_manage'), async (req, res) => {
  const companyCode = req.session.user.company_code;

  const [accounts] = await db.query(`
    SELECT a.*, g.name as group_name, g.group_code
    FROM accounts a
    JOIN \`groups\` g ON g.id = a.group_id
    WHERE a.company_code = ?
    ORDER BY g.group_code, a.account_code
  `, [companyCode]);

  // 🔥 ADD THIS
  const [groups] = await db.query(
    "SELECT * FROM `groups` WHERE company_code=?",
    [companyCode]
  );

  res.render('gl/accounts', { accounts, groups }); // ✅ FIXED
});

// ========Add-Account=========
app.get('/gl/add-account', (req, res) => res.redirect('/gl/accounts'));

app.post('/gl/add-account', isAuthenticated, async (req, res) => {
  const { name, group_id, manual_code, opening_balance } = req.body;
  const companyCode = req.session.user.company_code;

  // Minimum 2 digits, sirf numbers
  if (!/^\d{2,}$/.test(manual_code)) {
    req.flash('error', 'Account code minimum 2 digits hona chahiye');
    return res.redirect('/gl/accounts');
  }

  const [[group]] = await db.query(
    "SELECT group_code FROM `groups` WHERE id=? AND company_code=?",
    [group_id, companyCode]
  );

  if (!group) {
    req.flash('error', 'Group not found');
    return res.redirect('/gl/accounts');
  }

  // ✅ Direct merge — koi padding nahi, jaise import mein tha
  const account_code = group.group_code + manual_code;

  const [[exists]] = await db.query(
    "SELECT id FROM accounts WHERE account_code=? AND company_code=?",
    [account_code, companyCode]
  );

  if (exists) {
    req.flash('error', `Account ${account_code} already exists`);
    return res.redirect('/gl/accounts');
  }

  await db.query(`
    INSERT INTO accounts (account_code, name, group_id, opening_balance, company_code)
    VALUES (?, ?, ?, ?, ?)
  `, [account_code, name, group_id, opening_balance || 0, companyCode]);

  req.flash('success', `Account ${account_code} added`);
  res.redirect('/gl/accounts');
});

app.get('/gl/edit-account/:id', isAuthenticated, async (req, res) => {
  const companyCode = req.session.user.company_code;

  const [[account]] = await db.query(
    "SELECT * FROM accounts WHERE id=? AND company_code=?",
    [req.params.id, companyCode]
  );

  res.render('gl/edit-account', { account });
});

app.post('/gl/update-account/:id', isAuthenticated, async (req, res) => {
  const { name, opening_balance } = req.body;

  await db.query(
    "UPDATE accounts SET name=?, opening_balance=? WHERE id=?",
    [name, opening_balance, req.params.id]
  );

  req.flash('success', 'Account updated');
  res.redirect('/gl/accounts');
});

app.post('/gl/delete-account/:id', isAuthenticated, async (req, res) => {
  const companyCode = req.session.user.company_code;

  await db.query(
    "DELETE FROM accounts WHERE id=? AND company_code=?",
    [req.params.id, companyCode]
  );

  req.flash('success', 'Account deleted');
  res.redirect('/gl/accounts');
});

app.get('/gl/chart', isAuthenticated, async (req, res) => {
  const companyCode = req.session.user.company_code;

  const [accounts] = await db.query(`
    SELECT a.*, g.name as group_name, g.group_code
    FROM accounts a
    JOIN \`groups\` g ON g.id = a.group_id
    WHERE a.company_code = ?
    ORDER BY g.group_code, a.account_code
  `, [companyCode]);

  res.render('gl/chart', { accounts });
});

//===========Add Transaction=============

app.get('/gl/add-transaction', isAuthenticated, requirePermission('entry_add'), async (req, res) => {
  const { type, voucher_no } = req.query;
  const companyCode = req.session.user.company_code;

  if (!["receipt", "payment"].includes(type)) {
    return res.send("Invalid voucher type");
  }

  const voucher_type = type === "payment" ? "PV" : "RV";
  const entry_type = "CB";

  const [accounts] = await db.query(
    "SELECT account_code, name FROM accounts WHERE company_code = ? ORDER BY account_code",
    [companyCode]
  );

  const [[settings]] = await db.query(
    "SELECT cash_account_code FROM company_settings WHERE company_code = ?",
    [companyCode]
  );

  let editData = null;

  if (voucher_no) {
    const [rows] = await db.query(
      `SELECT * FROM transactions
       WHERE voucher_no = ? AND company_code = ?
       ORDER BY id`,
      [voucher_no, companyCode]
    );

    if (!rows.length) return res.send("Voucher not found");

    const cashAccount = settings?.cash_account_code;

    // Party row = cash account ke ilawa
    let partyRow = rows.find(r => r.account_code !== cashAccount);
    if (!partyRow) partyRow = rows[0];

    // Cash row = party ke ilawa
    const cashRow = rows.find(r => r.account_code !== partyRow.account_code);

    // Amount — party row se
    const amount = Number(partyRow.debit) > 0
      ? Number(partyRow.debit)
      : Number(partyRow.credit) > 0
        ? Number(partyRow.credit)
        : 0;

    // Date — timezone fix
    const rawDate = partyRow.date;
    let dateStr;
    if (rawDate instanceof Date) {
      const y = rawDate.getFullYear();
      const m = String(rawDate.getMonth() + 1).padStart(2, '0');
      const d = String(rawDate.getDate()).padStart(2, '0');
      dateStr = `${y}-${m}-${d}`;
    } else {
      dateStr = String(rawDate).slice(0, 10);
    }

    // ✅ FIX: both account names in 1 query
    const partyCode = partyRow.account_code;
    const cashCode = cashRow?.account_code || cashAccount;

    const [accNames] = await db.query(
      "SELECT account_code, name FROM accounts WHERE account_code IN (?, ?) AND company_code = ?",
      [partyCode, cashCode, companyCode]
    );
    const nameMap = {};
    accNames.forEach(a => { nameMap[a.account_code] = a.name; });

    editData = {
      voucher_no,
      date: dateStr,
      serial_no: partyRow.serial_no,
      account_code: partyCode,
      account_name: nameMap[partyCode] || partyCode,        // ✅ fix
      cash_account: cashCode,
      cash_account_name: nameMap[cashCode] || cashCode,     // ✅ fix
      description: partyRow.description,
      reference: partyRow.reference,
      invoice: partyRow.invoice,
      amount
    };
  }

  res.render("gl/add-transaction", {
    accounts,
    entry_type,
    voucher_type,
    settings,
    editData
  });
});

app.post('/gl/add-transaction', isAuthenticated, requirePermission('entry_add'), async (req, res) => {
  const {
    entry_type, voucher_type, date, voucher_no,
    serial_no, account_code, description,
    reference, invoice, amount, is_edit
  } = req.body;

  const companyCode = req.session.user.company_code;
  const amt = Number(amount) || 0;
  const serialNo = (serial_no && serial_no.toString().trim() !== '') ? parseInt(serial_no) : 1;

  const [[settings]] = await db.query(
    "SELECT cash_account_code FROM company_settings WHERE company_code = ?",
    [companyCode]
  );

  const CASH = req.body.cash_account || settings.cash_account_code;
  if (!CASH) return res.json({ success: false, message: "Cash account not set" });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    if (is_edit === "1") {
      // 🔥 Edit mode mein pehle cash entry dhundho — us ka cash code save karo
      const [oldRows] = await conn.query(
        "SELECT * FROM transactions WHERE voucher_no=? AND company_code=?",
        [voucher_no, companyCode]
      );

      // Cash row — jo party account ke ilawa hai
      const oldParty = oldRows.find(r => r.account_code !== CASH);
      const oldCash = oldRows.find(r => r.account_code !== oldParty?.account_code);

      await conn.query(
        "DELETE FROM transactions WHERE voucher_no=? AND company_code=?",
        [voucher_no, companyCode]
      );

      // 🔥 Edit mein original cash code use karo agar alag tha
      const useCash = oldCash?.account_code || CASH;

      // PARTY ENTRY
      await conn.query(`
        INSERT INTO transactions
        (entry_type, voucher_type, date, voucher_no, serial_no,
         account_code, debit, credit, description, reference, invoice, company_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry_type, voucher_type, date, voucher_no, serialNo,
          account_code,
          voucher_type === "PV" ? amt : 0,
          voucher_type === "RV" ? amt : 0,
          description, reference, invoice, companyCode
        ]
      );

      // CASH ENTRY
      await conn.query(`
        INSERT INTO transactions
        (entry_type, voucher_type, date, voucher_no, serial_no,
         account_code, debit, credit, description, reference, invoice, company_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry_type, voucher_type, date, voucher_no, serialNo,
          useCash,
          voucher_type === "RV" ? amt : 0,
          voucher_type === "PV" ? amt : 0,
          description, reference, invoice, companyCode
        ]
      );

    } else {
      // NEW TRANSACTION

      // PARTY ENTRY
      await conn.query(`
        INSERT INTO transactions
        (entry_type, voucher_type, date, voucher_no, serial_no,
         account_code, debit, credit, description, reference, invoice, company_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry_type, voucher_type, date, voucher_no, serialNo,
          account_code,
          voucher_type === "PV" ? amt : 0,
          voucher_type === "RV" ? amt : 0,
          description, reference, invoice, companyCode
        ]
      );

      // CASH ENTRY
      await conn.query(`
        INSERT INTO transactions
        (entry_type, voucher_type, date, voucher_no, serial_no,
         account_code, debit, credit, description, reference, invoice, company_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry_type, voucher_type, date, voucher_no, serialNo,
          CASH,
          voucher_type === "RV" ? amt : 0,
          voucher_type === "PV" ? amt : 0,
          description, reference, invoice, companyCode
        ]
      );
    }

    await conn.commit();
    res.json({ success: true, message: is_edit === "1" ? "Transaction Updated" : "Transaction Saved" });

  } catch (e) {
    await conn.rollback();
    res.json({ success: false, message: e.message });
  } finally {
    conn.release();
  }
});

// Get Next Voucher No
app.get('/api/next-voucher', isAuthenticated, async (req, res) => {
  let conn;
  try {
    const voucherType = req.query.voucher_type || 'RV';
    const companyCode = req.session.user.company_code;

    conn = await db.getConnection();

    // Prefix fetch
    const [[settings]] = await conn.query(
      `SELECT voucher_prefix_receipt, voucher_prefix_payment
       FROM company_settings WHERE company_code = ?`,
      [companyCode]
    );

    const prefix =
      voucherType === 'PV'
        ? (settings?.voucher_prefix_payment || '')
        : (settings?.voucher_prefix_receipt || '');

    // 🔥 Series filter — RV = 1 se shuru, PV = 2 se shuru
    const seriesStart = voucherType === 'PV' ? '2' : '1';
    const defaultStart = voucherType === 'PV' ? 2000001 : 1000001;

    const [[last]] = await conn.query(`
      SELECT voucher_no
      FROM transactions
      WHERE company_code = ?
        AND voucher_type = ?
        AND REGEXP_SUBSTR(voucher_no, '[0-9]+$') REGEXP '^${seriesStart}'
      ORDER BY CAST(REGEXP_SUBSTR(voucher_no, '[0-9]+$') AS UNSIGNED) DESC
      LIMIT 1
    `, [companyCode, voucherType]);

    let lastNumber = 0;
    if (last?.voucher_no) {
      const m = last.voucher_no.match(/\d+$/);
      if (m) lastNumber = parseInt(m[0]);
    }

    const nextNumber = lastNumber > 0 ? lastNumber + 1 : defaultStart;

    res.json({
      success: true,
      voucher_no: prefix + nextNumber
    });

  } catch (err) {
    console.error('Next voucher error:', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    if (conn) conn.release();
  }
});

app.get('/api/account-balance/:code', isAuthenticated, async (req, res) => {
  const companyCode = req.session.user.company_code;
  const code = req.params.code;

  // ✅ Single query — opening_balance + transaction totals in one shot
  const [[result]] = await db.query(`
    SELECT
      a.opening_balance,
      COALESCE(SUM(t.debit), 0)  AS total_debit,
      COALESCE(SUM(t.credit), 0) AS total_credit
    FROM accounts a
    LEFT JOIN transactions t
      ON t.account_code = a.account_code
     AND t.company_code = a.company_code
    WHERE a.account_code = ? AND a.company_code = ?
    GROUP BY a.opening_balance
  `, [code, companyCode]);

  if (!result) return res.json({ balance: "0.00" });

  const balance =
    Number(result.opening_balance || 0) +
    Number(result.total_debit) -
    Number(result.total_credit);

  res.json({ balance: balance.toFixed(2) });
});

app.get('/api/account-name/:code', isAuthenticated, async (req, res) => {
  const companyCode = req.session.user.company_code;
  const [rows] = await db.query(
    `SELECT name FROM accounts
     WHERE account_code = ? AND company_code = ?`,
    [req.params.code, companyCode]
  );
  res.json(rows[0] || {});
});

app.get('/dashboard', isAuthenticated, async (req, res) => {
  const companyCode = req.session.user.company_code;

  try {
    // ✅ 1 query: stats + settings + cashGroup — sab ek mein
    const [[info]] = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM accounts WHERE company_code = ?) AS total_accounts,
        (SELECT COUNT(DISTINCT voucher_no) FROM transactions WHERE company_code = ?) AS total_transactions,
        cs.cash_account_code,
        a.group_id AS cash_group_id
      FROM company_settings cs
      LEFT JOIN accounts a
        ON a.account_code = cs.cash_account_code
       AND a.company_code = cs.company_code
      WHERE cs.company_code = ?
    `, [companyCode, companyCode, companyCode]);

    const defaultGroupId = info?.cash_group_id || null;

    // ✅ 2nd query: groups
    const [groups] = await db.query(
      `SELECT id, group_code, name FROM \`groups\` WHERE company_code = ? ORDER BY group_code`,
      [companyCode]
    );

    const selectedGroupId = req.query.group_id ? Number(req.query.group_id) : defaultGroupId;

    // ✅ 3rd query: selected group accounts with balance (only if group selected)
    let cash_balances = [];
    if (selectedGroupId) {
      const [accounts] = await db.query(`
        SELECT
          a.account_code,
          a.name,
          a.opening_balance,
          IFNULL(SUM(t.debit),0)   AS debit,
          IFNULL(SUM(t.credit),0)  AS credit
        FROM accounts a
        LEFT JOIN transactions t
          ON t.account_code = a.account_code
          AND t.company_code = ?
        WHERE a.group_id = ? AND a.company_code = ?
        GROUP BY a.account_code, a.name, a.opening_balance
        ORDER BY a.account_code
      `, [companyCode, selectedGroupId, companyCode]);

      cash_balances = accounts.map(a => ({
        code: a.account_code,
        name: a.name,
        balance: Number(a.opening_balance || 0) + Number(a.debit || 0) - Number(a.credit || 0)
      }));
    }

    res.render('dashboard', {
      total_accounts: info?.total_accounts || 0,
      total_transactions: info?.total_transactions || 0,
      cash_balances,
      groups,
      selectedGroupId,
      defaultGroupId
    });

  } catch (err) {
    console.error("Dashboard error:", err);
    res.status(500).send("Dashboard error");
  }
});

// ==================== DAILY POSTING ====================
app.get('/daily-posting', isAuthenticated, requirePermission('daily_posting'), async (req, res) => {
  const companyCode = req.session.user.company_code;
  const today = new Date().toISOString().split('T')[0];

  const selectedDate = req.query.date || today;
  const dateType = req.query.type || 'posting'; // 'posting' ya 'entry'

  try {
    const [[settings]] = await db.query(
      'SELECT cash_account_code FROM company_settings WHERE company_code = ?',
      [companyCode]
    );
    const cashCode = settings?.cash_account_code;

    let CASH_CODES = new Set();
    if (cashCode) {
      const [cashAccList] = await db.query(`
        SELECT a2.account_code
        FROM accounts a1
        JOIN accounts a2 ON a2.group_id = a1.group_id AND a2.company_code = a1.company_code
        WHERE a1.account_code = ? AND a1.company_code = ?
      `, [cashCode, companyCode]);
      CASH_CODES = new Set(cashAccList.map(a => String(a.account_code).trim()));
      CASH_CODES.add(String(cashCode).trim());
    }

    // ✅ dateType ke hisaab se filter
    const dateColumn = dateType === 'entry' ? 'DATE(t.date)' : 'DATE(t.created_at)';

    const [rows] = await db.query(`
      SELECT 
        t.voucher_no,
        DATE_FORMAT(t.date, '%d-%m-%Y') AS formatted_date,
        t.description,
        t.reference,
        t.debit,
        t.credit,
        t.account_code,
        COALESCE(a.name, t.account_code) AS account_name
      FROM transactions t
      LEFT JOIN accounts a ON a.account_code = t.account_code 
                          AND a.company_code = t.company_code
      WHERE t.company_code = ?
      AND ${dateColumn} = ?
      ORDER BY t.voucher_no, t.id
    `, [companyCode, selectedDate]);

    const voucherMap = {};
    rows.forEach(r => {
      const key = r.voucher_no || 'NO-VOUCHER';
      if (!voucherMap[key]) voucherMap[key] = [];
      voucherMap[key].push(r);
    });

    const entries = [];
    const isCashCode = (code) => CASH_CODES.has(String(code).trim());

    Object.entries(voucherMap).forEach(([voucherNo, voucherLines]) => {
      let cashLine = voucherLines.find(l => isCashCode(l.account_code));
      let accountLine = voucherLines.find(l => !isCashCode(l.account_code));

      if (!cashLine && voucherLines.length >= 2) {
        accountLine = voucherLines[0];
        cashLine = voucherLines[1];
      }
      if (!accountLine) accountLine = voucherLines[0];

      const cashDebit = Number(cashLine?.debit || 0);
      const cashCredit = Number(cashLine?.credit || 0);

      let debit = 0, credit = 0;
      if (cashLine) {
        debit = cashCredit > 0 ? cashCredit : 0;
        credit = cashDebit > 0 ? cashDebit : 0;
      } else {
        debit = Number(accountLine.debit || 0);
        credit = Number(accountLine.credit || 0);
      }

      entries.push({
        voucher_no: voucherNo,
        formatted_date: accountLine.formatted_date,
        description: accountLine.description || '',
        account_code: accountLine.account_code,
        account_name: accountLine.account_name,
        // cash_code: cashLine ? cashLine.account_code : '-',
        // cash_name: cashLine ? (cashLine.account_name || cashLine.account_code) : '-',
        reference: accountLine.reference || '',
        debit,
        credit,
      });
    });

    res.render('daily-posting', { entries, selectedDate, dateType, fmt });

  } catch (err) {
    console.error('Daily posting error:', err);
    res.status(500).send('Error loading daily posting');
  }
});

app.get('/report', isAuthenticated, requirePermission('reports_view'), async (req, res) => {
  const companyCode = req.session.user.company_code;
  try {
    const [accounts] = await db.query(
      'SELECT account_code, name FROM accounts WHERE company_code = ? ORDER BY account_code',
      [companyCode]
    );

    const [entryTypes] = await db.query(
      'SELECT DISTINCT entry_type FROM transactions WHERE company_code = ? AND entry_type IS NOT NULL',
      [companyCode]
    );

    res.render('report', { accounts, entryTypes });
  } catch (err) {
    console.error("Report page error:", err);
    res.status(500).send("Error loading report filter.");
  }
});

// ==================== REPORT RESULT ====================
app.post('/report-result', isAuthenticated, requirePermission('reports_view'), async (req, res) => {
  let { start_date, end_date, from_account, to_account } = req.body;
  const companyCode = req.session.user.company_code;

  if (!to_account) to_account = from_account;

  const parseDMY = d => {
    const [dd, mm, yy] = d.split('-');
    return `${yy}-${mm}-${dd}`;
  };

  const formattedStart = parseDMY(start_date);
  const formattedEnd = parseDMY(end_date);

  // ✅ Feature flag se against_account column show hoga
  const showAgainst = req.features.against_column || false;

  try {
    const [accountsList] = await db.query(
      `SELECT account_code, name, opening_balance
       FROM accounts
       WHERE company_code = ?
       AND CAST(account_code AS UNSIGNED) >= CAST(? AS UNSIGNED)
       AND CAST(account_code AS UNSIGNED) <= CAST(? AS UNSIGNED)
       ORDER BY CAST(account_code AS UNSIGNED)`,
      [companyCode, from_account, to_account]
    );

    if (!accountsList.length)
      return res.status(404).send('No accounts found in this range');

    const accountCodesNum = accountsList.map(a => Number(a.account_code));

    // Opening balances
    const [prevRows] = await db.query(
      `SELECT account_code,
         COALESCE(SUM(debit),0)  AS debit,
         COALESCE(SUM(credit),0) AS credit
       FROM transactions
       WHERE company_code = ? AND DATE(date) < ? AND account_code IN (?)
       GROUP BY account_code`,
      [companyCode, formattedStart, accountCodesNum]
    );

    // Transactions — showAgainst ke hisaab se against_account bhi lao
    const txnQuery = showAgainst
      ? `SELECT
           t.account_code,
           DATE_FORMAT(t.date,'%d-%m-%Y') AS formatted_date,
           t.voucher_no, t.description, t.reference, t.debit, t.credit,
           (
             SELECT a2.name
             FROM transactions t2
             JOIN accounts a2 ON a2.account_code = t2.account_code
                              AND a2.company_code = t2.company_code
             WHERE t2.voucher_no   = t.voucher_no
               AND t2.account_code != t.account_code
               AND t2.company_code  = t.company_code
             LIMIT 1
           ) AS against_account
         FROM transactions t
         WHERE t.company_code = ?
         AND DATE(t.date) BETWEEN ? AND ?
         AND t.account_code IN (?)
         ORDER BY t.date, t.id`
      : `SELECT
           account_code,
           DATE_FORMAT(date,'%d-%m-%Y') AS formatted_date,
           voucher_no, description, reference, debit, credit,
           NULL AS against_account
         FROM transactions
         WHERE company_code = ?
         AND DATE(date) BETWEEN ? AND ?
         AND account_code IN (?)
         ORDER BY date, id`;

    const [allTxns] = await db.query(
      txnQuery,
      [companyCode, formattedStart, formattedEnd, accountCodesNum]
    );

    // Maps
    const prevMap = {};
    prevRows.forEach(r => { prevMap[Number(r.account_code)] = r; });

    const txnMap = {};
    allTxns.forEach(t => {
      const key = Number(t.account_code);
      if (!txnMap[key]) txnMap[key] = [];
      txnMap[key].push(t);
    });

    const results = accountsList.map(acc => {
      const key = Number(acc.account_code);
      const prev = prevMap[key] || { debit: 0, credit: 0 };
      const opening_balance =
        Number(acc.opening_balance || 0) +
        Number(prev.debit || 0) -
        Number(prev.credit || 0);

      return {
        account_code: acc.account_code,
        name: acc.name,
        opening_balance,
        transactions: txnMap[key] || []
      };
    });

    res.render('report-result', {
      results,
      from_account,
      to_account,
      start_date,
      end_date,
      showAgainst,
      fmt
    });

  } catch (err) {
    console.error('REPORT ERROR:', err);
    res.status(500).send('Error generating report');
  }
});

// TRIAL BALANCE - filter page
app.get('/trial-balance', isAuthenticated, requirePermission('trial_balance'), async (req, res) => {
  const companyCode = req.session.user.company_code;
  try {
    const [accounts] = await db.query(
      `SELECT account_code AS code, name 
       FROM accounts 
       WHERE company_code = ? 
       ORDER BY name`,
      [companyCode]
    );
    res.render('trial-balance', { accounts, company_code: companyCode });
  } catch (err) {
    console.error('Trial Balance page error:', err);
    res.status(500).send('Error loading trial balance filter.');
  }
});

// TRIAL BALANCE - result
app.post('/trial-balance-result', isAuthenticated, async (req, res) => {
  try {
    const companyCode = req.session.user.company_code;
    const { start_date, end_date, zero_values } = req.body;

    const parseDMY = d => {
      const [dd, mm, yyyy] = d.split('-');
      return `${yyyy}-${mm}-${dd}`;
    };

    const sDate = parseDMY(start_date);
    const eDate = parseDMY(end_date);

    const query = `
      SELECT
        g.group_code,
        g.name AS group_name,
        a.account_code,
        a.name AS account_name,
        a.opening_balance,
        COALESCE(SUM(t.debit),0)  AS debit,
        COALESCE(SUM(t.credit),0) AS credit
      FROM \`groups\` g
      JOIN accounts a 
        ON a.group_id = g.id
       AND a.company_code = g.company_code
      LEFT JOIN transactions t
        ON t.account_code = a.account_code
       AND t.company_code = ?
       AND t.date BETWEEN ? AND ?
      WHERE g.company_code = ?
      GROUP BY g.group_code, g.name,
               a.account_code, a.name, a.opening_balance
      ORDER BY g.group_code, a.account_code
    `;

    const [rows] = await db.query(query, [companyCode, sDate, eDate, companyCode]);

    const groups = {};
    let sno = 1;

    rows.forEach(r => {
      const balance =
        Number(r.opening_balance || 0) +
        Number(r.debit || 0) -
        Number(r.credit || 0);

      const debit = balance > 0 ? balance : 0;
      const credit = balance < 0 ? Math.abs(balance) : 0;

      if (zero_values !== 'yes' && debit === 0 && credit === 0) return;

      if (!groups[r.group_code]) {
        groups[r.group_code] = {
          group_code: r.group_code,
          group_name: r.group_name,
          accounts: [],
          total_debit: 0,
          total_credit: 0,
          difference: 0
        };
      }

      groups[r.group_code].accounts.push({
        sno: sno++,
        account_code: r.account_code,
        account_name: r.account_name,
        debit,
        credit
      });

      groups[r.group_code].total_debit += debit;
      groups[r.group_code].total_credit += credit;
    });

    Object.values(groups).forEach(g => {
      g.difference = g.total_debit - g.total_credit;
    });

    let grand = { debit: 0, credit: 0, difference: 0 };
    Object.values(groups).forEach(g => {
      grand.debit += g.total_debit;
      grand.credit += g.total_credit;
    });
    grand.difference = grand.debit - grand.credit;

    res.render('trial-balance-result', {
      groups: Object.values(groups),
      grand,
      start_date,
      end_date,
      fmt,
      company_code: companyCode
    });

  } catch (err) {
    console.error(err);
    res.status(500).send('Trial Balance error');
  }
});

// CASH BOOK - FILTER PAGE
app.get('/cash-book', isAuthenticated, requirePermission('cash_book'), async (req, res) => {
  try {
    res.render('cash-book', {
      company_code: req.session.user.company_code
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading cash book');
  }
});

// CASH BOOK - RESULT
app.post('/cash-book-result', isAuthenticated, requirePermission('cash_book'), async (req, res) => {
  const { start_date, end_date } = req.body;
  const company_code = req.session.user.company_code;

  const [[settings]] = await db.query(
    "SELECT cash_account_code FROM company_settings WHERE company_code = ?",
    [company_code]
  );
  const CASH = settings?.cash_account_code;

  if (!CASH) {
    return res.render('cash-book-result', {
      error: 'Cash account not set in company settings!',
      rows: [], totals: { debit: 0, credit: 0 },
      opening: 0, start_date, end_date, company_code, cash_account: ''
    });
  }

  const parseDMY = d => {
    if (!d) return null;
    if (d.includes('-') && d.split('-')[0].length === 4) return d;
    const [dd, mm, yyyy] = d.split('-');
    return `${yyyy}-${mm}-${dd}`;
  };

  const sDate = parseDMY(start_date);
  const eDate = parseDMY(end_date);

  try {
    // ✅ Feature flag: multi_cash_book enabled ho to cash group ke saare accounts
    let cashCodes = [CASH];

    if (req.features.multi_cash_book) {
      const [[cashAcc]] = await db.query(
        `SELECT group_id FROM accounts WHERE account_code = ? AND company_code = ?`,
        [CASH, company_code]
      );

      if (cashAcc?.group_id) {
        const [groupAccounts] = await db.query(
          `SELECT account_code FROM accounts WHERE group_id = ? AND company_code = ?`,
          [cashAcc.group_id, company_code]
        );
        cashCodes = groupAccounts.map(a => a.account_code);
      }
    }

    // Opening balance — saare cash codes ka combined
    const [[{ opening }]] = await db.query(`
      SELECT IFNULL(SUM(debit - credit), 0) AS opening
      FROM transactions
      WHERE account_code IN (?)
        AND DATE(date) < ?
        AND company_code = ?
    `, [cashCodes, sDate, company_code]);

    // Transactions — account name bhi lao (Shahid ke liye useful)
    const [rows] = await db.query(`
  SELECT
    DATE_FORMAT(c.date, '%d-%m-%Y') AS date,
    c.voucher_no,
    c.account_code,
    a.name AS account_name,
    c.description,
    c.reference,
    c.debit,
    c.credit,
    -- ✅ Opposite (party) account
    (
      SELECT CONCAT(t2.account_code, ' - ', COALESCE(a2.name, t2.account_code))
      FROM transactions t2
      LEFT JOIN accounts a2 ON a2.account_code = t2.account_code
                            AND a2.company_code = t2.company_code
      WHERE t2.voucher_no  = c.voucher_no
        AND t2.account_code NOT IN (?)
        AND t2.company_code = c.company_code
      LIMIT 1
    ) AS party_account
  FROM transactions c
  LEFT JOIN accounts a ON a.account_code = c.account_code
                       AND a.company_code = c.company_code
  WHERE c.account_code IN (?)
    AND c.company_code = ?
    AND DATE(c.date) BETWEEN ? AND ?
  ORDER BY c.date, c.id
`, [cashCodes, cashCodes, company_code, sDate, eDate]);

    // Running balance
    let runningBalance = Number(opening || 0);
    const rowsWithBalance = rows.map(r => {
      runningBalance += Number(r.debit || 0) - Number(r.credit || 0);
      return { ...r, balance: runningBalance };
    });

    const totals = {
      debit: rows.reduce((s, r) => s + Number(r.debit || 0), 0),
      credit: rows.reduce((s, r) => s + Number(r.credit || 0), 0)
    };

    const isMultiCash = req.features.multi_cash_book || false;

    res.render('cash-book-result', {
      rows: rowsWithBalance,
      totals,
      opening,
      start_date,
      end_date,
      fmt,
      company_code,
      cash_account: CASH,
      isShahid: isMultiCash   // frontend variable same rakha — EJS change na ho
    });

  } catch (err) {
    console.error('Cash book error:', err);
    res.render('cash-book-result', {
      error: 'Error loading cash book',
      rows: [], totals: { debit: 0, credit: 0 },
      opening: 0, start_date, end_date, fmt,
      company_code, cash_account: CASH || '',
      isShahid: false
    });
  }
});

app.get('/search', isAuthenticated, async (req, res) => {
  const { query, message } = req.query;
  const company_code = req.session.user.company_code;

  if (!query || !query.trim()) {
    return res.render('search-results', {
      vouchers: [],
      message: null,
      query: ""
    });
  }

  const [[settings]] = await db.query(
    "SELECT cash_account_code FROM company_settings WHERE company_code = ?",
    [company_code]
  );

  const CASH = settings?.cash_account_code;

  // 🔥 Har voucher ke liye party row fetch karo (non-cash row)
  const [rows] = await db.query(`
    SELECT
      t.voucher_no,
      DATE_FORMAT(MIN(t.date),'%d-%m-%Y') AS date,
      MAX(t.voucher_type) AS voucher_type,
      MIN(t.account_code) AS account_code,
      MIN(a.name) AS account_name,
      MIN(t.description) AS description,
      MIN(t.reference) AS reference,
      SUM(CASE WHEN t.debit > 0 THEN t.debit ELSE 0 END) AS debit,
      SUM(CASE WHEN t.credit > 0 THEN t.credit ELSE 0 END) AS credit
    FROM transactions t
    JOIN accounts a
      ON a.account_code = t.account_code
     AND a.company_code = t.company_code
    WHERE t.company_code = ?
      AND t.account_code != ?
      AND (
        t.voucher_no LIKE ?
        OR a.name LIKE ?
        OR t.description LIKE ?
        OR t.reference LIKE ?
      )
    GROUP BY t.voucher_no
    ORDER BY MIN(t.date) DESC, t.voucher_no DESC
    LIMIT 100
  `, [
    company_code,
    CASH,
    `%${query}%`,
    `%${query}%`,
    `%${query}%`,
    `%${query}%`
  ]);

  res.render('search-results', {
    vouchers: rows,
    message: rows.length ? null : 'Transaction not found',
    query
  });
});

app.post('/gl/delete-voucher/:voucher_no', isAuthenticated, async (req, res) => {
  const { voucher_no } = req.params;
  const company_code = req.session.user.company_code;

  await db.query(
    'DELETE FROM transactions WHERE voucher_no = ? AND company_code = ?',
    [voucher_no, company_code]
  );

  req.flash('success', 'Voucher deleted');
  res.redirect('/search?query=&message=Deleted');
});

// ================================================================
//  INVOICES (SELL & PURCHASE) MODULE
//  app.js mein paste karo — app.listen() se pehle
//  Requires: db, isAuthenticated (already defined in your app.js)
// ================================================================

// ================================================================
//  INVOICES (SELL & PURCHASE) MODULE — UPDATED
//  app.js mein paste karo — app.listen() se pehle
//  Requires: db, isAuthenticated (already defined in your app.js)
//
//  FIXES IN THIS VERSION:
//  1. accounts list ab GET routes mein fetch + pass hoti hai
//     (seller/buyer searchable dropdown ke liye)
//  2. "phone" field ko net amount formula se HATA diya —
//     yeh phone number hai, deduction nahi
// ================================================================

function invToDBDate(d) {
  if (!d) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const [dd, mm, yyyy] = d.split('-');
  return `${yyyy}-${mm}-${dd}`;
}
function invToDisplayDate(d) {
  if (!d) return '';
  const s = d instanceof Date
    ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    : String(d).slice(0, 10);
  const [y, m, dd] = s.split('-');
  return `${dd}-${m}-${y}`;
}
const invN = v => parseFloat(v) || 0;

// ── GET /invoices — list ────────────────────────────────────────
app.get('/invoices', isAuthenticated, requirePermission('invoice_view'), async (req, res) => {
  const cc = req.session.user.company_code;
  try {
    const [invoices] = await db.query(`
      SELECT id, bill_no,
             DATE_FORMAT(bill_date,'%d-%m-%Y') AS bill_date,
             vehicle_no, seller_code, buyer_code,
             bags, seller_weight, buyer_weight,
             seller_rate, buyer_rate,
             seller_net, buyer_net, diff
      FROM invoices
      WHERE company_code = ?
      ORDER BY bill_date DESC, CAST(bill_no AS UNSIGNED) DESC
      LIMIT 300
    `, [cc]);

    res.render('invoices/list', { invoices, fmt });
  } catch (err) {
    console.error('Invoices list error:', err);
    req.flash('error', 'Could not load invoices');
    res.redirect('/dashboard');
  }
});

// ── GET /invoices/add — new invoice form ────────────────────────
app.get('/invoices/add', isAuthenticated, requirePermission('invoice_view'), async (req, res) => {
  const cc = req.session.user.company_code;
  try {
    const [[last]] = await db.query(
      `SELECT bill_no FROM invoices
       WHERE company_code = ?
       ORDER BY CAST(bill_no AS UNSIGNED) DESC LIMIT 1`,
      [cc]
    );
    const nextBillNo = last ? (parseInt(last.bill_no) + 1) : 1;

    const now = new Date();
    const today = `${String(now.getDate()).padStart(2, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${now.getFullYear()}`;

    // ✅ FIX: accounts list fetch karo — dropdown search ke liye
    const [accounts] = await db.query(
      "SELECT account_code, name FROM accounts WHERE company_code = ? ORDER BY account_code",
      [cc]
    );

    res.render('invoices/form', {
      inv: null, nextBillNo, today,
      sellerName: '', sellerBal: 0,
      buyerName: '', buyerBal: 0,
      accounts,                         // ✅ NEW
      fmt
    });
  } catch (err) {
    console.error('Invoice add error:', err);
    req.flash('error', 'Error opening form');
    res.redirect('/invoices');
  }
});

// ── GET /invoices/edit/:id — edit existing invoice ──────────────
app.get('/invoices/edit/:id', isAuthenticated, requirePermission('invoice_view'), async (req, res) => {
  const cc = req.session.user.company_code;
  try {
    const [[inv]] = await db.query(
      'SELECT * FROM invoices WHERE id = ? AND company_code = ?',
      [req.params.id, cc]
    );
    if (!inv) {
      req.flash('error', 'Invoice not found');
      return res.redirect('/invoices');
    }
    inv.bill_date = invToDisplayDate(inv.bill_date);

    // ✅ FIX: phone hata diya gross amount reconstruction se
    inv.seller_amount = invN(inv.seller_net)
      + invN(inv.seller_cartage) + invN(inv.seller_brokery)
      + invN(inv.seller_mf) + invN(inv.seller_other);
    inv.buyer_amount = invN(inv.buyer_net)
      + invN(inv.buyer_cartage) - invN(inv.buyer_brokery)
      + invN(inv.buyer_mf) + invN(inv.buyer_other);

    let sellerName = '', sellerBal = 0, buyerName = '', buyerBal = 0;

    if (inv.seller_code) {
      const [[sa]] = await db.query(
        'SELECT name, opening_balance FROM accounts WHERE account_code=? AND company_code=?',
        [inv.seller_code, cc]
      );
      if (sa) {
        sellerName = sa.name;
        const [[st]] = await db.query(
          `SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c
           FROM transactions WHERE account_code=? AND company_code=?`,
          [inv.seller_code, cc]
        );
        sellerBal = invN(sa.opening_balance) + invN(st.d) - invN(st.c);
      }
    }
    if (inv.buyer_code) {
      const [[ba]] = await db.query(
        'SELECT name, opening_balance FROM accounts WHERE account_code=? AND company_code=?',
        [inv.buyer_code, cc]
      );
      if (ba) {
        buyerName = ba.name;
        const [[bt]] = await db.query(
          `SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c
           FROM transactions WHERE account_code=? AND company_code=?`,
          [inv.buyer_code, cc]
        );
        buyerBal = invN(ba.opening_balance) + invN(bt.d) - invN(bt.c);
      }
    }

    // ✅ FIX: accounts list fetch karo — dropdown search ke liye
    const [accounts] = await db.query(
      "SELECT account_code, name FROM accounts WHERE company_code = ? ORDER BY account_code",
      [cc]
    );

    res.render('invoices/form', {
      inv, nextBillNo: null, today: inv.bill_date,
      sellerName, sellerBal,
      buyerName, buyerBal,
      accounts,                         // ✅ NEW
      fmt
    });
  } catch (err) {
    console.error('Invoice edit error:', err);
    req.flash('error', 'Error loading invoice');
    res.redirect('/invoices');
  }
});

// ── POST /invoices/save — insert or update ──────────────────────
app.post('/invoices/save', isAuthenticated, requirePermission('invoice_view'), async (req, res) => {
  const cc = req.session.user.company_code;
  const b = req.body;

  // ✅ FIX: phone hata diya net calculation se — yeh phone number hai
  const sNet = invN(b.seller_amount)
    - invN(b.seller_cartage) - invN(b.seller_brokery)
    - invN(b.seller_mf) - invN(b.seller_other);
  const bNet = invN(b.buyer_amount)
    - invN(b.buyer_cartage) + invN(b.buyer_brokery)
    - invN(b.buyer_mf) - invN(b.buyer_other);
  const diff = Math.round(bNet - sNet);

  const fields = [
    b.bill_no?.trim(), invToDBDate(b.bill_date), b.vehicle_no || null,
    b.seller_code || null, invN(b.seller_inv_no), invN(b.seller_serial),
    b.buyer_code || null, invN(b.buyer_inv_no),
    invN(b.bags),
    invN(b.seller_weight), invN(b.buyer_weight),
    invN(b.seller_rate), invN(b.buyer_rate),
    invN(b.seller_cartage), invN(b.buyer_cartage),
    invN(b.seller_mf), invN(b.buyer_mf),
    invN(b.seller_brokery), invN(b.buyer_brokery),
    b.seller_phone || null, b.buyer_phone || null,   // ✅ phone ab text/null hai, calc mein nahi
    invN(b.seller_other), invN(b.buyer_other),
    Math.round(sNet), Math.round(bNet), diff
  ];

  try {
    if (b.invoice_id) {
      await db.query(`
        UPDATE invoices SET
          bill_no=?,        bill_date=?,       vehicle_no=?,
          seller_code=?,    seller_inv_no=?,   seller_serial=?,
          buyer_code=?,     buyer_inv_no=?,
          bags=?,
          seller_weight=?,  buyer_weight=?,
          seller_rate=?,    buyer_rate=?,
          seller_cartage=?, buyer_cartage=?,
          seller_mf=?,      buyer_mf=?,
          seller_brokery=?, buyer_brokery=?,
          seller_phone=?,   buyer_phone=?,
          seller_other=?,   buyer_other=?,
          seller_net=?,     buyer_net=?,       diff=?
        WHERE id=? AND company_code=?`,
        [...fields, b.invoice_id, cc]
      );
      req.flash('success', `Invoice #${b.bill_no} updated successfully`);
    } else {
      await db.query(`
        INSERT INTO invoices (
          bill_no, bill_date, vehicle_no,
          seller_code, seller_inv_no, seller_serial,
          buyer_code,  buyer_inv_no,
          bags,
          seller_weight, buyer_weight,
          seller_rate,   buyer_rate,
          seller_cartage,buyer_cartage,
          seller_mf,     buyer_mf,
          seller_brokery,buyer_brokery,
          seller_phone,  buyer_phone,
          seller_other,  buyer_other,
          seller_net,    buyer_net,    diff,
          company_code
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [...fields, cc]
      );
      req.flash('success', `Invoice #${b.bill_no} saved successfully`);
    }
    res.redirect('/invoices');
  } catch (err) {
    console.error('Invoice save error:', err);
    req.flash('error', 'Save failed: ' + err.message);
    res.redirect(b.invoice_id ? `/invoices/edit/${b.invoice_id}` : '/invoices/add');
  }
});

// ── POST /invoices/delete/:id ────────────────────────────────────
app.post('/invoices/delete/:id', isAuthenticated, requirePermission('invoice_view'), async (req, res) => {
  const cc = req.session.user.company_code;
  try {
    await db.query('DELETE FROM invoices WHERE id=? AND company_code=?', [req.params.id, cc]);
    req.flash('success', 'Invoice deleted');
  } catch (err) {
    console.error('Invoice delete error:', err);
    req.flash('error', 'Could not delete invoice');
  }
  res.redirect('/invoices');
});

// ── API: next bill no ────────────────────────────────────────────
app.get('/invoices/api/next-bill-no', isAuthenticated, async (req, res) => {
  const cc = req.session.user.company_code;
  const [[last]] = await db.query(
    `SELECT bill_no FROM invoices WHERE company_code=?
     ORDER BY CAST(bill_no AS UNSIGNED) DESC LIMIT 1`,
    [cc]
  );
  res.json({ next: last ? parseInt(last.bill_no) + 1 : 1 });
});

// ── API: party lookup by code (still used as fallback balance fetch) ─
app.get('/invoices/api/party/:code', isAuthenticated, async (req, res) => {
  const cc = req.session.user.company_code;
  const code = req.params.code.trim();
  const [[acc]] = await db.query(
    'SELECT name, opening_balance FROM accounts WHERE account_code=? AND company_code=?',
    [code, cc]
  );
  if (!acc) return res.json({ found: false });

  const [[txn]] = await db.query(
    `SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c
     FROM transactions WHERE account_code=? AND company_code=?`,
    [code, cc]
  );
  const balance = invN(acc.opening_balance) + invN(txn.d) - invN(txn.c);
  res.json({ found: true, name: acc.name, balance: balance.toFixed(2) });
});

// ===================== COMPANY ADMIN — User Access Control =====================
app.get('/company-admin', isAuthenticated, async (req, res) => {
  const user = req.session.user;
  if (user.role !== 'admin' && user.company_role !== 'company_admin') {
    req.flash('error', 'Access denied.');
    return res.redirect('/dashboard');
  }

  const companyCode = user.company_code;

  const [users] = await db.query(
    `SELECT id, username, company_role, permissions, last_login 
     FROM users 
     WHERE company_code = ? AND username != ?
     ORDER BY username`,
    [companyCode, user.username]
  );

  const usersWithPerms = users.map(u => ({
    ...u,
    permissions: u.permissions
      ? (typeof u.permissions === 'string' ? JSON.parse(u.permissions) : u.permissions)
      : {}
  }));

  res.render('company-admin', {
    companyUsers: usersWithPerms,
    allPermissions: [
      { key: 'entry_add',       label: 'Add Voucher' },
      { key: 'entry_edit',      label: 'Edit Voucher' },
      { key: 'entry_delete',    label: 'Delete Voucher' },
      { key: 'reports_view',    label: 'GL Transactions' },
      { key: 'trial_balance',   label: 'Trial Balance' },
      { key: 'cash_book',       label: 'Cash Book' },
      { key: 'daily_posting',   label: 'Daily Posting' },
      { key: 'invoice_view',    label: 'Invoices' },
      { key: 'accounts_manage', label: 'Manage Accounts' },
      { key: 'import_data',     label: 'Import Data' },
    ],
    error:   req.flash('error'),
    success: req.flash('success')
  });
});

// ✅ Company Admin — Add user to own company
app.post('/company-admin/add-user', isAuthenticated, async (req, res) => {
  const sessionUser = req.session.user;
  if (sessionUser.role !== 'admin' && sessionUser.company_role !== 'company_admin') {
    req.flash('error', 'Access denied.');
    return res.redirect('/dashboard');
  }

  const { username, password, company_role } = req.body;
  const companyCode = sessionUser.company_code; // sirf apni company mein

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const actualCompanyRole = company_role === 'company_admin' ? 'company_admin' : 'user';

    await db.query(
      'INSERT INTO users (company_code, username, password, role, company_role) VALUES (?, ?, ?, ?, ?)',
      [companyCode, username, hashedPassword, 'user', actualCompanyRole]
    );
    req.flash('success', `User ${username} added successfully.`);
  } catch (err) {
    console.error('Company admin add user error:', err);
    req.flash('error', 'Failed to add user. Username may already exist.');
  }
  res.redirect('/company-admin');
});

// ✅ Company Admin — Delete user from own company
app.post('/company-admin/delete-user/:id', isAuthenticated, async (req, res) => {
  const sessionUser = req.session.user;
  if (sessionUser.role !== 'admin' && sessionUser.company_role !== 'company_admin') {
    req.flash('error', 'Access denied.');
    return res.redirect('/dashboard');
  }

  try {
    // Sirf apni company ke user delete kar sakta hai
    await db.query(
      'DELETE FROM users WHERE id = ? AND company_code = ?',
      [req.params.id, sessionUser.company_code]
    );
    req.flash('success', 'User deleted.');
  } catch (err) {
    console.error('Company admin delete error:', err);
    req.flash('error', 'Failed to delete user.');
  }
  res.redirect('/company-admin');
});

app.post('/company-admin/update-permissions/:id', isAuthenticated, async (req, res) => {
  const user = req.session.user;
  if (user.role !== 'admin' && user.company_role !== 'company_admin') {
    return res.redirect('/dashboard');
  }

  const permKeys = [
    'entry_add','entry_edit','entry_delete',
    'reports_view','trial_balance','cash_book','daily_posting',
    'invoice_view','accounts_manage','import_data'
  ];

  const permissions = {};
  permKeys.forEach(k => { permissions[k] = req.body[k] === 'on'; });

  const company_role = req.body.company_role || 'user';

  try {
    await db.query(
      'UPDATE users SET permissions = ?, company_role = ? WHERE id = ? AND company_code = ?',
      [JSON.stringify(permissions), company_role, req.params.id, user.company_code]
    );
    req.flash('success', 'Permissions updated.');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to update permissions.');
  }
  res.redirect('/company-admin');
});

// ===================== SUPER ADMIN — Feature Flags =====================
const AVAILABLE_FEATURES = [
  { key: 'against_column',   label: 'Against Account Column (Ledger/Report)' },
  { key: 'multi_cash_book',  label: 'Multi Cash Account Book' },
  { key: 'sell_purchase',    label: 'Sell & Purchase Invoice Module' },
  { key: 'daily_posting',    label: 'Daily Posting Module' },
];

app.get('/admin/features', isAuthenticated, isAdmin, async (req, res) => {
  const [companies] = await db.query(
    'SELECT DISTINCT company_code FROM company_settings ORDER BY company_code'
  );

  const [allFeatures] = await db.query(
    'SELECT * FROM company_features ORDER BY company_code, feature_key'
  );

  const featureMap = {};
  allFeatures.forEach(f => {
    if (!featureMap[f.company_code]) featureMap[f.company_code] = {};
    featureMap[f.company_code][f.feature_key] = f.enabled;
  });

  res.render('admin-features', {
    companies,
    featureMap,
    availableFeatures: AVAILABLE_FEATURES,
    error:   req.flash('error'),
    success: req.flash('success')
  });
});

app.post('/admin/features/update', isAuthenticated, isAdmin, async (req, res) => {
  const { company_code } = req.body;

  try {
    for (const feat of AVAILABLE_FEATURES) {
      const enabled = req.body[feat.key] === 'on' ? 1 : 0;
      await db.query(`
        INSERT INTO company_features (company_code, feature_key, enabled)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)
      `, [company_code, feat.key, enabled]);
    }
    await logAdminAction(req, 'Updated features', company_code);
    req.flash('success', `Features updated for ${company_code}`);
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to update features.');
  }
  res.redirect('/admin/features');
});

// app.listen(3000, () => console.log('Server running on http://localhost:3000'));
// Automatically detect IPv4 of this PC

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    for (const config of iface) {
      if (config.family === 'IPv4' && !config.internal) {
        return config.address;
      }
    }
  }
  return 'localhost';
}

const localIP = getLocalIP();
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`========================================`);
  console.log(` SERVER RUNNING SUCCESSFULLY`);
  console.log(`----------------------------------------`);
  console.log(` Local:   http://localhost:${PORT}`);
  console.log(` LAN:     http://${localIP}:${PORT}`);
  console.log(`========================================`);
});
