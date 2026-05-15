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
const { isAuthenticated } = require('./middleware/auth');
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
  return Number(n || 0)
    .toFixed(2)
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
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

    // ✅ Store session with company info
    req.session.user = {
      id: user.id,
      username: user.username,
      role: user.role,
      company_code: user.company_code
    };

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
function isAdmin(req, res, next) {
  if (req.session.user && req.session.user.role === 'admin') {
    return next();
  }
  req.flash('error', 'Access denied.');
  res.redirect('/dashboard');
}

app.use(expressLayouts);
app.set('layout', 'layout');

// ========== USER MANAGEMENT (Admin Only) ==========
app.get('/users', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const [users] = await db.query('SELECT id, username, role, company_code FROM users');
    res.render('users', { users, error: req.flash('error'), success: req.flash('success') });
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

    // 🔍 Check if this company is new
    const [[companyExists]] = await db.query(
      "SELECT company_code FROM users WHERE company_code = ? LIMIT 1",
      [company_code]
    );

    const hashedPassword = await bcrypt.hash(password, 10);

    // Create new user
    await db.query(
      'INSERT INTO users (company_code, username, password, role) VALUES (?, ?, ?, ?)',
      [company_code, username, hashedPassword, role]
    );

    // ==============================
    // ⭐ INSERT DEFAULT GROUPS IF NEW COMPANY
    // ==============================
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


      if (!companyExists) {
        for (const g of DEFAULT_GROUPS) {
          await db.query(
            "INSERT INTO `groups` (group_code, name, company_code) VALUES (?, ?, ?)",
            [g.code, g.name, company_code]
          );
        }
      }

      // Also create empty company settings automatically
      await db.query(`
        INSERT INTO company_settings 
        (company_code, cash_account_code, voucher_prefix_receipt, voucher_prefix_payment, financial_year_start, financial_year_end)
        VALUES (?, '', '', '', '', '')
      `, [company_code]);
    }

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
    req.flash('success', 'User deleted successfully.');
  } catch (err) {
    console.error('Delete user error:', err);
    req.flash('error', 'Could not delete user.');
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

    const conn = await db.getConnection();
    await conn.beginTransaction();

    for (const row of rows) {

      /* ================= ACCOUNT IMPORT ================= */
      if (importType === "account") {

        const code_raw = row.code || row.account_code || row.Code;

        if (!code_raw) {
          console.log("Missing code field:", row);
          skippedCount++;
          continue;
        }

        const full_code = String(code_raw).trim();

        if (full_code.length < 5) {
          console.log("Code too short:", full_code);
          skippedCount++;
          continue;
        }

        if (!/^\d+$/.test(full_code)) {
          console.log("Invalid code (non-numeric):", full_code);
          skippedCount++;
          continue;
        }

        const group_code = full_code.slice(0, 4);

        const [[group]] = await conn.query(
          "SELECT id FROM `groups` WHERE group_code=? AND company_code=?",
          [group_code, companyCode]
        );

        if (!group) {
          console.log("Group NOT FOUND:", group_code);
          skippedCount++;
          continue;
        }

        const account_code = full_code;
        const name = (row.name || row.Name || "").toString().trim() || account_code;
        const opening_balance = Number(row.opening_balance || row.Opening_Balance || 0);

        try {
          await conn.query(`
            INSERT INTO accounts
            (group_id, account_code, name, opening_balance, company_code)
            VALUES (?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
              name = VALUES(name),
              opening_balance = VALUES(opening_balance),
              group_id = VALUES(group_id)
          `, [group.id, account_code, name, opening_balance, companyCode]);
          accountCount++;
        } catch (err) {
          console.log("Insert Error:", err.message);
          skippedCount++;
        }
      }

      /* ================= TRANSACTION IMPORT ================= */
      if (importType === "transaction" && row.account_code && row.voucher_no) {

        const entry_type = (row.type || "CB").toString().trim();

        const voucher_type_raw = (row.voucher_type || "").toString().trim().toUpperCase().replace(/\s+/g, '');
        const voucher_type = ["RV", "PV"].includes(voucher_type_raw) ? voucher_type_raw : "RV";

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
            let year = yy;
            if (yy.length === 2) year = Number(yy) > 50 ? "19" + yy : "20" + yy;
            return `${year}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
          }
          if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
          return null;
        }

        const trxDate = parseDDMMYYYY(row.date);
        if (!trxDate) {
          console.log("Invalid date:", row.date);
          skippedCount++;
          continue;
        }

        const voucher_no = row.voucher_no.toString().trim();
        const serial_no = row.serial_no ? parseInt(row.serial_no) : 1;
        const account_code = row.account_code.toString().trim();

        // 🔥 Account check — nahi mila to auto create
        let [[accExists]] = await conn.query(
          "SELECT id FROM accounts WHERE account_code=? AND company_code=?",
          [account_code, companyCode]
        );

        if (!accExists) {
          // Auto create — group pehle 4 digits se
          const auto_group_code = account_code.slice(0, 4);
          const [[autoGroup]] = await conn.query(
            "SELECT id FROM `groups` WHERE group_code=? AND company_code=?",
            [auto_group_code, companyCode]
          );

          if (autoGroup) {
            await conn.query(`
              INSERT INTO accounts (group_id, account_code, name, opening_balance, company_code)
              VALUES (?, ?, ?, 0, ?)
              ON DUPLICATE KEY UPDATE account_code = account_code
            `, [autoGroup.id, account_code, account_code, companyCode]);
            console.log("✅ Auto created account:", account_code);

            // Naya insert hua — refetch karo
            [[accExists]] = await conn.query(
              "SELECT id FROM accounts WHERE account_code=? AND company_code=?",
              [account_code, companyCode]
            );
          } else {
            console.log("❌ Group not found for auto-create:", account_code);
            skippedCount++;
            continue;
          }
        }

        const debit = Number(row.debit || 0);
        const credit = Number(row.credit || 0);

        const description = row.description || null;
        const reference = row.reference || null;
        const invoice = row.invoice || null;

        // 🔥 Cash code — validate karo, fallback CASH
        let cashCode = row.cash_code ? row.cash_code.toString().trim() : CASH;

        const [[cashExists]] = await conn.query(
          "SELECT id FROM accounts WHERE account_code=? AND company_code=?",
          [cashCode, companyCode]
        );

        if (!cashExists) {
          console.log(`Cash code ${cashCode} not found, using default: ${CASH}`);
          cashCode = CASH;
        }

        if (!cashCode) {
          console.log("Cash account missing, skipping");
          skippedCount++;
          continue;
        }

        // PARTY ENTRY
        await conn.query(`
          INSERT INTO transactions
          (entry_type, voucher_type, date, voucher_no, serial_no,
           account_code, debit, credit, description, reference, invoice, company_code)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [entry_type, voucher_type, trxDate, voucher_no, serial_no,
          account_code, debit, credit, description, reference, invoice, companyCode]);

        // CASH ENTRY
        await conn.query(`
          INSERT INTO transactions
          (entry_type, voucher_type, date, voucher_no, serial_no,
           account_code, debit, credit, description, reference, invoice, company_code)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [entry_type, voucher_type, trxDate, voucher_no, serial_no,
          cashCode, credit, debit, description, reference, invoice, companyCode]);

        txnCount += 2;
      }
    }

    await conn.commit();
    conn.release();
    fs.unlinkSync(filePath);

    const [settingsData] = await db.query(
      'SELECT * FROM company_settings WHERE company_code = ?',
      [companyCode]
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

    // 🔥 conn release karo agar open hai
    try { if (conn) { await conn.rollback(); conn.release(); } } catch (e) { }

    const [settingsData] = await db.query(
      'SELECT * FROM company_settings WHERE company_code = ?',
      [companyCode]   // ← ye upper scope se aana chahiye
    ).catch(() => [[]]);

    return res.render('setup/settings', {
      settings: settingsData[0] || {},
      messages: {
        success: [],
        error: [`❌ Import failed: ${err.message}`]
      }
    });
  }
});

app.get('/gl/groups', isAuthenticated, async (req, res) => {
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
app.get('/gl/accounts', isAuthenticated, async (req, res) => {
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

app.get('/gl/add-transaction', isAuthenticated, async (req, res) => {
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

    // ✅ FIX: account names fetch karo taake search box mein show hon
    const partyCode = partyRow.account_code;
    const cashCode = cashRow?.account_code || cashAccount;

    const [[partyAcc]] = await db.query(
      "SELECT name FROM accounts WHERE account_code=? AND company_code=?",
      [partyCode, companyCode]
    );
    const [[cashAcc]] = await db.query(
      "SELECT name FROM accounts WHERE account_code=? AND company_code=?",
      [cashCode, companyCode]
    );

    editData = {
      voucher_no,
      date: dateStr,
      serial_no: partyRow.serial_no,
      // party
      account_code: partyCode,
      account_name: partyAcc?.name || partyCode,   // ✅ NEW
      // cash
      cash_account: cashCode,
      cash_account_name: cashAcc?.name || cashCode,    // ✅ NEW
      // rest
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

app.post('/gl/add-transaction', isAuthenticated, async (req, res) => {
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

  const [[acc]] = await db.query(
    "SELECT opening_balance FROM accounts WHERE account_code=? AND company_code=?",
    [code, companyCode]
  );

  if (!acc) return res.json({ balance: "0.00" });

  const [[sum]] = await db.query(`
    SELECT COALESCE(SUM(debit),0) AS debit,
           COALESCE(SUM(credit),0) AS credit
    FROM transactions
    WHERE account_code=? AND company_code=?`,
    [code, companyCode]
  );

  const balance =
    Number(acc.opening_balance || 0) +
    Number(sum.debit) -
    Number(sum.credit);

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
    const [[stats]] = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM accounts WHERE company_code = ?) AS total_accounts,
        (SELECT COUNT(DISTINCT voucher_no) FROM transactions WHERE company_code = ?) AS total_transactions
    `, [companyCode, companyCode]);

    const [[settings]] = await db.query(
      "SELECT cash_account_code FROM company_settings WHERE company_code=?",
      [companyCode]
    );

    const CASH_ACCOUNT = settings?.cash_account_code;

    // Cash group find karo
    const [[cashGroup]] = await db.query(
      `SELECT group_id FROM accounts WHERE account_code = ? AND company_code = ?`,
      [CASH_ACCOUNT, companyCode]
    );

    const defaultGroupId = cashGroup?.group_id || null;

    // Saare groups fetch karo
    const [groups] = await db.query(
      `SELECT id, group_code, name FROM \`groups\` WHERE company_code = ? ORDER BY group_code`,
      [companyCode]
    );

    // Selected group — query param ya default cash group
    const selectedGroupId = req.query.group_id ? Number(req.query.group_id) : defaultGroupId;

    // Selected group ke accounts with balance
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
      total_accounts: stats.total_accounts,
      total_transactions: stats.total_transactions,
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
app.get('/daily-posting', isAuthenticated, async (req, res) => {
  const companyCode = req.session.user.company_code;
  const dateParam = req.query.date;
  const today = new Date().toISOString().split('T')[0];
  const selectedDate = dateParam || today;

  try {
    // Cash account code fetch karo
    const [[settings]] = await db.query(
      'SELECT cash_account_code FROM company_settings WHERE company_code = ?',
      [companyCode]
    );
    const cashCode = settings?.cash_account_code;

    // Cash group_id nikalo — exact match on account_code
    let cashGroupId = null;
    if (cashCode) {
      const [[cashAcc]] = await db.query(
        `SELECT group_id FROM accounts WHERE account_code = ? AND company_code = ?`,
        [cashCode, companyCode]
      );
      cashGroupId = cashAcc?.group_id;
    }

    // Us group ke saare accounts — yeh cash/bank hain
    let CASH_CODES = new Set();
    if (cashGroupId) {
      const [cashAccList] = await db.query(
        `SELECT account_code FROM accounts WHERE group_id = ? AND company_code = ?`,
        [cashGroupId, companyCode]
      );
      CASH_CODES = new Set(cashAccList.map(a => String(a.account_code).trim()));
    }
    // Agar cashCode khud bhi CASH_CODES mein nahi hai to add karo (fallback)
    if (cashCode) CASH_CODES.add(String(cashCode).trim());

    // Us din ki saari transactions — LEFT JOIN so cash rows don't get dropped
    const [rows] = await db.query(`
      SELECT 
        t.voucher_no,
        DATE_FORMAT(t.date, '%d-%m-%Y') AS formatted_date,
        t.description,
        t.debit,
        t.credit,
        t.account_code,
        COALESCE(a.name, t.account_code) AS account_name
      FROM transactions t
      LEFT JOIN accounts a ON a.account_code = t.account_code 
                      AND a.company_code = t.company_code
      WHERE t.company_code = ?
      AND DATE(t.created_at) = ?
      ORDER BY t.voucher_no, t.id
    `, [companyCode, selectedDate]);

    // Voucher wise group
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

      // Fallback: agar CASH_CODES se detect nahi hua aur 2 lines hain,
      // to pehli line = account, doosri line = cash
      if (!cashLine && voucherLines.length >= 2) {
        accountLine = voucherLines[0];
        cashLine = voucherLines[1];
      }

      if (!accountLine) {
        accountLine = voucherLines[0];
      }

      const cashDebit = Number(cashLine?.debit || 0);
      const cashCredit = Number(cashLine?.credit || 0);

      let debit = 0;
      let credit = 0;

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
        cash_code: cashLine ? cashLine.account_code : '-',
        cash_name: cashLine ? (cashLine.account_name || cashLine.account_code) : '-',
        debit,
        credit,
      });
    });

    res.render('daily-posting', { entries, selectedDate, fmt });

  } catch (err) {
    console.error('Daily posting error:', err);
    res.status(500).send('Error loading daily posting');
  }
});

app.get('/report', isAuthenticated, async (req, res) => {
  const companyCode = req.session.user.company_code;
  try {
    const [accounts] = await db.query(
      'SELECT account_code, name FROM accounts WHERE company_code = ? ORDER BY account_code',
      [companyCode]
    );
    // ❌ accounts.unshift({ account_code: 'ALL', name: 'All Accounts' }); // hata do

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
app.post('/report-result', isAuthenticated, async (req, res) => {
  let { start_date, end_date, from_account, to_account } = req.body;
  const companyCode = req.session.user.company_code;

  // To blank ho to From hi use karo
  if (!to_account) to_account = from_account;

  const parseDMY = d => {
    const [dd, mm, yy] = d.split('-');
    return `${yy}-${mm}-${dd}`;
  };

  const formattedStart = parseDMY(start_date);
  const formattedEnd = parseDMY(end_date);

  try {
    // From - To range ke accounts
    const [accountsList] = await db.query(
      `SELECT account_code, name, opening_balance
       FROM accounts
       WHERE company_code = ?
       AND account_code >= ? AND account_code <= ?
       ORDER BY account_code`,
      [companyCode, from_account, to_account]
    );

    if (!accountsList.length)
      return res.status(404).send('No accounts found in this range');

    // Har account ka data
    const results = [];

    for (const acc of accountsList) {
      // Opening balance before start_date
      const [[prev]] = await db.query(
        `SELECT
           COALESCE(SUM(debit),0)  AS debit,
           COALESCE(SUM(credit),0) AS credit
         FROM transactions
         WHERE company_code = ? AND DATE(date) < ? AND account_code = ?`,
        [companyCode, formattedStart, acc.account_code]
      );

      const opening_balance =
        Number(acc.opening_balance || 0) +
        Number(prev.debit || 0) -
        Number(prev.credit || 0);

      // Transactions
      const [transactions] = await db.query(
        `SELECT
           DATE_FORMAT(date,'%d-%m-%Y') AS formatted_date,
           voucher_no, description, reference, debit, credit
         FROM transactions
         WHERE company_code = ?
         AND DATE(date) BETWEEN ? AND ?
         AND account_code = ?
         ORDER BY date, id`,
        [companyCode, formattedStart, formattedEnd, acc.account_code]
      );

      results.push({
        account_code: acc.account_code,
        name: acc.name,
        opening_balance,
        transactions
      });
    }

    res.render('report-result', {
      results,
      from_account,
      to_account,
      start_date,
      end_date,
      fmt
    });

  } catch (err) {
    console.error('REPORT ERROR:', err);
    res.status(500).send('Error generating report');
  }
});

// TRIAL BALANCE - filter page
app.get('/trial-balance', isAuthenticated, async (req, res) => {
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
app.get('/cash-book', isAuthenticated, async (req, res) => {
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
app.post('/cash-book-result', isAuthenticated, async (req, res) => {
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
    // Opening balance
    const [[{ opening }]] = await db.query(`
      SELECT IFNULL(SUM(debit - credit), 0) AS opening
      FROM transactions
      WHERE account_code = ?
        AND DATE(date) < ?
        AND company_code = ?
    `, [CASH, sDate, company_code]);

    // ✅ Subquery hata di — simple flat query
    const [rows] = await db.query(`
      SELECT
        DATE_FORMAT(c.date, '%d-%m-%Y') AS date,
        c.voucher_no,
        c.description,
        c.reference,
        c.debit,
        c.credit
      FROM transactions c
      WHERE c.account_code = ?
        AND c.company_code = ?
        AND DATE(c.date) BETWEEN ? AND ?
      ORDER BY c.date, c.id
    `, [CASH, company_code, sDate, eDate]);

    // ✅ Running balance JS mein
    let runningBalance = Number(opening || 0);
    const rowsWithBalance = rows.map(r => {
      runningBalance += Number(r.debit || 0) - Number(r.credit || 0);
      return { ...r, balance: runningBalance };
    });

    const totals = {
      debit: rows.reduce((s, r) => s + Number(r.debit || 0), 0),
      credit: rows.reduce((s, r) => s + Number(r.credit || 0), 0)
    };

    res.render('cash-book-result', {
      rows: rowsWithBalance,
      totals,
      opening,
      start_date,
      end_date,
      fmt,
      company_code,
      cash_account: CASH
    });

  } catch (err) {
    console.error('Cash book error:', err);
    res.render('cash-book-result', {
      error: 'Error loading cash book',
      rows: [], totals: { debit: 0, credit: 0 },
      opening: 0, start_date, end_date, fmt,
      company_code, cash_account: CASH || ''
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