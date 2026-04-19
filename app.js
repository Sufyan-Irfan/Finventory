require("dotenv").config();
console.log("🔍 APP.JS LOADED");
console.log("🔍 MYSQLHOST:", process.env.MYSQLHOST);
console.log("🔍 MYSQLPORT:", process.env.MYSQLPORT);
const express = require('express');
const path = require('path');
const db = require('./db');
const mysql = require("mysql2");
const expressLayouts = require('express-ejs-layouts');
const session = require('express-session');
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
const ExcelJS = require('exceljs');

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('Trial Balance');
const upload = multer({ dest: "uploads/" });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(session({ secret: 'ledger_secret', resave: false, saveUninitialized: true }));
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
    function parseImportDate(val) {
      if (!val) return null;

      // Excel numeric date
      if (typeof val === "number") {
        const d = xlsx.SSF.parse_date_code(val);
        if (!d) return null;
        const mm = String(d.m).padStart(2, "0");
        const dd = String(d.d).padStart(2, "0");
        const yy = String(d.y);
        return `${yy}-${mm}-${dd}`;
      }

      // YYYY-MM-DD
      if (/^\d{4}-\d{2}-\d{2}$/.test(val)) {
        return val;
      }

      // MM/DD/YYYY or MM/DD/YY
      if (typeof val === "string" && val.includes("/")) {
        const [mm, dd, yy] = val.split("/");
        let year = yy;
        if (yy.length === 2) {
          year = Number(yy) > 50 ? "19" + yy : "20" + yy;
        }
        return `${year}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
      }

      return null;
    }


    const filePath = req.file.path;
    const companyCode = req.session.user.company_code;
    const importType = req.body.import_type;

    const workbook = xlsx.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });

    let accountCount = 0;
    let txnCount = 0;

    const [[settings]] = await db.query(
      "SELECT cash_account_code FROM company_settings WHERE company_code = ?",
      [companyCode]
    );

    const CASH = settings?.cash_account_code;
    if (!CASH) throw new Error("Cash account not set");

    const conn = await db.getConnection();
    await conn.beginTransaction();

    for (const row of rows) {

      /* ================= ACCOUNT IMPORT ================= */
      if (importType === "account") {

        // 🔥 SAFE HEADER ACCESS
        const group_code_raw = row.group_code || row.Group_Code || row["group code"];
        const manual_code_raw = row.manual_code || row.manual_code || row["manual code"];

        if (!group_code_raw || !manual_code_raw) {
          console.log("Missing fields:", row);
          continue;
        }

        // 🔥 FORCE STRING + FIX LEADING ZERO
        let group_code = String(group_code_raw).trim().padStart(4, '0');
        let manual_code = String(manual_code_raw).trim();

        // ✅ VALIDATION
        if (!/^\d{4}$/.test(group_code)) {
          console.log("Invalid group_code:", group_code);
          continue;
        }

        if (!/^\d{1,5}$/.test(manual_code)) {
          console.log("Invalid manual_code:", manual_code);
          continue;
        }

        // 🔥 FIND GROUP
        const [[group]] = await conn.query(
          "SELECT id FROM `groups` WHERE group_code=? AND company_code=?",
          [group_code, companyCode]
        );

        if (!group) {
          console.log("Group NOT FOUND in DB:", group_code);
          continue;
        }

        // 🔥 FINAL ACCOUNT CODE
        const suffix = manual_code.padStart(5, '0');
        const account_code = group_code + suffix;

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
    `, [
            group.id,
            account_code,
            name,
            opening_balance,
            companyCode
          ]);

          accountCount++;

        } catch (err) {
          console.log("Insert Error:", err.message);
        }
      }

      /* ================= TRANSACTION IMPORT ================= */
      if (importType === "transaction" && row.account_code && row.voucher_no) {

        const entry_type = (row.type || "CB").toString().trim(); // CB / SP
        const voucher_type = (row.voucher_type || "").toString().trim(); // RV / PV

        if (!["RV", "PV"].includes(voucher_type)) {
          console.log("Invalid voucher_type:", voucher_type);
          continue;
        }

        // ✅ DATE PARSE (DD/MM/YYYY)
        function parseDDMMYYYY(val) {
          if (!val) return null;

          // Excel number date
          if (typeof val === "number") {
            const d = xlsx.SSF.parse_date_code(val);
            if (!d) return null;
            return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
          }

          // dd/mm/yyyy
          if (typeof val === "string" && val.includes("/")) {
            const [dd, mm, yy] = val.split("/");

            if (!dd || !mm || !yy) return null;

            let year = yy;
            if (yy.length === 2) {
              year = Number(yy) > 50 ? "19" + yy : "20" + yy;
            }

            return `${year}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
          }

          return null;
        }

        const trxDate = parseDDMMYYYY(row.date);
        if (!trxDate) {
          console.log("Invalid date:", row.date);
          continue;
        }

        const voucher_no = row.voucher_no.toString().trim();
const serial_no = row.serial_no ? parseInt(row.serial_no) : 1;
        let account_code = row.account_code.toString().trim();

        // ✅ ACCOUNT CHECK
        const [[accExists]] = await conn.query(
          "SELECT id FROM accounts WHERE account_code=? AND company_code=?",
          [account_code, companyCode]
        );

        if (!accExists) {
          console.log("Account not found:", account_code);
          continue;
        }

        const debit = Number(row.debit || 0);
        const credit = Number(row.credit || 0);

        if (debit === 0 && credit === 0) {
          console.log("Empty amount");
          continue;
        }

        const description = row.description || null;
        const reference = row.reference || null;
        const invoice = row.invoice || null;

        // ✅ CASH CODE
        let CASH = row.cash_code;

        if (!CASH) {
          const [[settings]] = await conn.query(
            "SELECT cash_account_code FROM company_settings WHERE company_code=?",
            [companyCode]
          );
          CASH = settings?.cash_account_code;
        }

        if (!CASH) {
          console.log("Cash account missing");
          continue;
        }

        // ===== PARTY ENTRY =====
        await conn.query(`
    INSERT INTO transactions
    (entry_type, voucher_type, date, voucher_no, serial_no,
     account_code, debit, credit,
     description, reference, invoice, company_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
          entry_type,
          voucher_type,
          trxDate,
          voucher_no,
          serial_no,
          account_code,
          debit,
          credit,
          description,
          reference,
          invoice,
          companyCode
        ]);

        // ===== CASH ENTRY =====
        await conn.query(`
    INSERT INTO transactions
    (entry_type, voucher_type, date, voucher_no, serial_no,
     account_code, debit, credit,
     description, reference, invoice, company_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
          entry_type,
          voucher_type,
          trxDate,
          voucher_no,
          serial_no,
          CASH,
          credit,
          debit,
          description,
          reference,
          invoice,
          companyCode
        ]);

        txnCount += 2;
      }
    }

    await conn.commit();
    conn.release();
    fs.unlinkSync(filePath);

    req.flash("success", `${accountCount} accounts, ${txnCount} transactions imported`);
    res.redirect("/setup/settings");

  } catch (err) {
    console.error("IMPORT ERROR:", err);
    req.flash("error", err.message);
    res.redirect("/setup/settings");
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

  if (!/^\d{4}$/.test(group_code)) {
    req.flash('error', 'Group code must be 4 digits');
    return res.redirect('/gl/groups'); // ✅ FIX
  }

  const [[exists]] = await db.query(
    "SELECT id FROM `groups` WHERE group_code=? AND company_code=?",
    [group_code, companyCode]
  );

  if (exists) {
    req.flash('error', 'Group already exists');
    return res.redirect('/gl/groups'); // ✅ FIX
  }

  await db.query(
    "INSERT INTO `groups` (group_code, name, company_code) VALUES (?, ?, ?)",
    [group_code, name, companyCode]
  );

  req.flash('success', 'Group added');
  res.redirect('/gl/groups'); // already correct
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

  if (!/^\d{1,5}$/.test(manual_code)) {
    req.flash('error', 'Invalid account code');
    return res.redirect('/gl/add-account');
  }

  const [[group]] = await db.query(
    "SELECT group_code FROM `groups` WHERE id=? AND company_code=?",
    [group_id, companyCode]
  );

  const suffix = manual_code.padStart(5, '0');
  const account_code = group.group_code + suffix;

  const [[exists]] = await db.query(
    "SELECT id FROM accounts WHERE account_code=? AND company_code=?",
    [account_code, companyCode]
  );

  if (exists) {
    req.flash('error', 'Account exists');
    return res.redirect('/gl/add-account');
  }

  await db.query(`
    INSERT INTO accounts
    (account_code, name, group_id, opening_balance, company_code)
    VALUES (?, ?, ?, ?, ?)
  `, [
    account_code,
    name,
    group_id,
    opening_balance || 0,
    companyCode
  ]);

  req.flash('success', 'Account added');
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

  // ===== EDIT MODE =====
  if (voucher_no) {
    const [rows] = await db.query(
      `SELECT * FROM transactions
     WHERE voucher_no = ? AND company_code = ?
     ORDER BY id`,
      [voucher_no, companyCode]
    );

    if (!rows.length) return res.send("Voucher not found");

    let partyRow;

    if (voucher_type === "RV") {
      partyRow = rows.find(r => Number(r.debit) > 0);
    } else {
      partyRow = rows.find(r => Number(r.credit) > 0);
    }

    if (!partyRow) return res.send("Invalid voucher data");

    editData = {
      voucher_no,
      date: partyRow.date.toISOString().slice(0, 10),
      serial_no: partyRow.serial_no,
      account_code: partyRow.account_code,
      description: partyRow.description,
      reference: partyRow.reference,
      invoice: partyRow.invoice,
      amount: Number(partyRow.debit || partyRow.credit)
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
  const amt = Number(amount);
  const serialNo = (serial_no && serial_no.toString().trim() !== '') ? parseInt(serial_no) : 1; // ← FIX

  const [[settings]] = await db.query(
    "SELECT cash_account_code FROM company_settings WHERE company_code = ?",
    [companyCode]
  );

  const CASH = settings.cash_account_code;
  if (!CASH) return res.json({ success: false, message: "Cash account not set" });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    if (is_edit === "1") {
      await conn.query(
        "DELETE FROM transactions WHERE voucher_no=? AND company_code=?",
        [voucher_no, companyCode]
      );
    }

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

    // 🔥 ALWAYS read last voucher (prefix or no prefix)
    const startNumber = (voucherType === 'PV') ? 200001 : 100001;
    const endNumber = (voucherType === 'PV') ? 299999 : 199999;

    const [[last]] = await conn.query(`
  SELECT voucher_no
  FROM transactions
  WHERE company_code = ?
    AND voucher_type = ?
    AND CAST(REGEXP_SUBSTR(voucher_no, '[0-9]+$') AS UNSIGNED)
        BETWEEN ? AND ?
  ORDER BY CAST(REGEXP_SUBSTR(voucher_no, '[0-9]+$') AS UNSIGNED) DESC
  LIMIT 1
`, [companyCode, voucherType, startNumber, endNumber]);


    let lastNumber = 0;
    if (last?.voucher_no) {
      const m = last.voucher_no.match(/\d+$/);
      if (m) lastNumber = parseInt(m[0]);
    }

    const nextNumber = lastNumber > 0 ? lastNumber + 1 : startNumber;

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

    /* ================= BASIC COUNTS ================= */
    const [[stats]] = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM accounts WHERE company_code = ?) AS total_accounts,
        (SELECT COUNT(DISTINCT voucher_no) FROM transactions WHERE company_code = ?) AS total_transactions
    `, [companyCode, companyCode]);


    /* ================= GET CASH ACCOUNT CODE ================= */
    const [[settings]] = await db.query(
      "SELECT cash_account_code FROM company_settings WHERE company_code=?",
      [companyCode]
    );

    if (!settings || !settings.cash_account_code) {
      return res.render('dashboard', {
        total_accounts: stats.total_accounts,
        total_transactions: stats.total_transactions,
        cash_balances: []
      });
    }

    const CASH_ACCOUNT = settings.cash_account_code;


    /* ================= GET CASH GROUP ================= */
    const [[cashGroup]] = await db.query(`
      SELECT group_id 
      FROM accounts 
      WHERE account_code = ? AND company_code = ?
    `, [CASH_ACCOUNT, companyCode]);

    if (!cashGroup) {
      return res.render('dashboard', {
        total_accounts: stats.total_accounts,
        total_transactions: stats.total_transactions,
        cash_balances: []
      });
    }


    /* ================= CASH ACCOUNTS ================= */
    const [cashAccounts] = await db.query(`
      SELECT
        a.account_code,
        a.name,
        a.opening_balance,
        IFNULL(SUM(t.debit),0) AS debit,
        IFNULL(SUM(t.credit),0) AS credit
      FROM accounts a
      LEFT JOIN transactions t
        ON t.account_code = a.account_code
        AND t.company_code = ?
      WHERE a.group_id = ?
        AND a.company_code = ?
      GROUP BY a.account_code, a.name, a.opening_balance
      ORDER BY a.name
    `, [companyCode, cashGroup.group_id, companyCode]);


    /* ================= FINAL BALANCES ================= */
    const cash_balances = cashAccounts.map(a => ({
      name: a.name,
      balance:
        Number(a.opening_balance || 0) +
        Number(a.debit || 0) -
        Number(a.credit || 0)
    }));


    /* ================= RENDER ================= */
    res.render('dashboard', {
      total_accounts: stats.total_accounts,
      total_transactions: stats.total_transactions,
      cash_balances
    });

  } catch (err) {
    console.error("Dashboard error:", err);
    res.status(500).send("Dashboard error");
  }
});

// ==================== REPORT FILTER PAGE ====================
app.get('/report', isAuthenticated, async (req, res) => {
  const companyCode = req.session.user.company_code;

  try {
    // Accounts
    const [accounts] = await db.query(
      'SELECT account_code, name FROM accounts WHERE company_code = ?', [companyCode]
    );
    accounts.unshift({ account_code: 'ALL', name: 'All Accounts' });

    // Unique entry_type values
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
  let { start_date, end_date, account, entry_type } = req.body;
  const companyCode = req.session.user.company_code;

  try {

    const parseDMY = d => {
      const [dd, mm, yy] = d.split('-');
      return `${yy}-${mm}-${dd}`;
    };

    const formattedStart = parseDMY(start_date);
    const formattedEnd = parseDMY(end_date);

    let whereClause = `
      company_code = ?
      AND DATE(date) BETWEEN ? AND ?
    `;
    let params = [companyCode, formattedStart, formattedEnd];

    let party = null;
    let opening_balance = 0;

    // ================= SINGLE ACCOUNT =================
    if (account && account !== 'ALL') {

      whereClause += ` AND account_code = ?`;
      params.push(account);

      const [[acc]] = await db.query(
        `SELECT name, opening_balance
         FROM accounts
         WHERE account_code = ? AND company_code = ?`,
        [account, companyCode]
      );

      if (!acc) return res.status(404).send('Account not found');

      // Opening balance
      const [[prev]] = await db.query(
        `SELECT
           COALESCE(SUM(debit),0)  AS debit,
           COALESCE(SUM(credit),0) AS credit
         FROM transactions
         WHERE company_code = ?
         AND DATE(date) < ?
         AND account_code = ?`,
        [companyCode, formattedStart, account]
      );

      opening_balance =
        Number(acc.opening_balance || 0) +
        Number(prev.debit || 0) -
        Number(prev.credit || 0);

      party = { name: acc.name, opening_balance };

    } else {

      // ================= ALL ACCOUNTS =================
      const [[prev]] = await db.query(
        `SELECT
           COALESCE(SUM(debit),0)  AS debit,
           COALESCE(SUM(credit),0) AS credit
         FROM transactions
         WHERE company_code = ?
         AND DATE(date) < ?`,
        [companyCode, formattedStart]
      );

      opening_balance =
        Number(prev.debit || 0) -
        Number(prev.credit || 0);

      party = { name: 'All Accounts', opening_balance };
    }

    // ================= ENTRY TYPE =================
    // ================= TRANSACTIONS (FINAL FIX) =================
    let transactionsQuery = `
  SELECT
    DATE_FORMAT(date,'%d-%m-%Y') AS formatted_date,
    voucher_no,
    description,
    debit,
    credit
  FROM transactions
  WHERE ${whereClause}
`;

    // 🔥 FIX FOR ALL ACCOUNTS (remove cash entries)
    if (!account || account === 'ALL') {
      transactionsQuery += `
    AND account_code != (
      SELECT cash_account_code 
      FROM company_settings 
      WHERE company_code = ?
    )
  `;
      params.push(companyCode);
    }

    transactionsQuery += ` ORDER BY date, id`;

    const [transactions] = await db.query(transactionsQuery, params);

    res.render('report-result', {
      transactions,
      party,
      start_date,
      end_date
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

    res.render('trial-balance', {
      accounts,
      company_code: companyCode
    });
  } catch (err) {
    console.error('Trial Balance page error:', err);
    res.status(500).send('Error loading trial balance filter.');
  }
});

// TRIAL BALANCE - result (optimized)
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

    // ✅ QUERY (IMPORTANT - rows yahin define ho raha hai)
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

    const [rows] = await db.query(query, [
      companyCode,
      sDate,
      eDate,
      companyCode
    ]);

    // ===== GROUP BUILD =====
    const groups = {};

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
        account_name: r.account_name,
        debit,
        credit
      });

      groups[r.group_code].total_debit += debit;
      groups[r.group_code].total_credit += credit;
    });

    // ✅ GROUP DIFFERENCE
    Object.values(groups).forEach(g => {
      g.difference = g.total_debit - g.total_credit;
    });

    // ✅ GRAND TOTAL
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
  const { start_date, end_date, cash_account } = req.body;
  const company_code = req.session.user.company_code;

  const CASH = cash_account;

  try {

    /* ============ OPENING BALANCE ============ */
    const [[{ opening }]] = await db.query(`
      SELECT IFNULL(SUM(debit - credit),0) AS opening
      FROM transactions
      WHERE account_code = ?
        AND date < ?
        AND company_code = ?
    `, [CASH, start_date, company_code]);

    /* ============ CASH BOOK ENTRIES ============ */
    const [rows] = await db.query(`
      SELECT
        DATE_FORMAT(c.date,'%d-%m-%Y') AS date,
        c.voucher_no,

        CONCAT(
          CASE 
            WHEN c.debit > 0 THEN 'Received from '
            ELSE 'Paid to '
          END,
          a.name
        ) AS description,

        c.reference,
        c.debit,
        c.credit,

        /* RUNNING BALANCE */
        (
          SELECT IFNULL(SUM(x.debit - x.credit),0)
          FROM transactions x
          WHERE x.account_code = ?
            AND x.date <= c.date
            AND x.company_code = ?
        ) AS balance

      FROM transactions c

      /* OPPOSITE ENTRY (DOUBLE ENTRY) */
      JOIN transactions o
        ON o.voucher_no = c.voucher_no
       AND o.account_code <> c.account_code
       AND o.company_code = c.company_code

      /* OPPOSITE ACCOUNT NAME */
      JOIN accounts a
        ON a.account_code = o.account_code
       AND a.company_code = c.company_code

      WHERE c.account_code = ?
        AND c.company_code = ?
        AND c.date BETWEEN ? AND ?

      ORDER BY c.date, c.id
    `, [
      CASH, company_code,
      CASH, company_code,
      start_date, end_date
    ]);

    /* ============ TOTALS ============ */
    const totals = {
      debit: rows.reduce((s, r) => s + Number(r.debit || 0), 0),
      credit: rows.reduce((s, r) => s + Number(r.credit || 0), 0)
    };

    res.render('cash-book-result', {
      rows,
      totals,
      opening,
      start_date,
      end_date,
      company_code,
      cash_account: CASH
    });

  } catch (err) {
    console.error(err);
    res.render('cash-book-result', {
      error: 'Error loading cash book'
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

  const [rows] = await db.query(`
    SELECT
      t.voucher_no,
      DATE_FORMAT(MAX(t.date),'%d-%m-%Y') AS date,
      MAX(t.voucher_type) AS voucher_type,   -- ✅ IMPORTANT
      MAX(a.account_code) AS account_code,
      MAX(a.name) AS account_name,
      MAX(t.description) AS description,
      MAX(t.reference) AS reference,

      SUM(CASE WHEN t.debit > 0 THEN t.debit ELSE 0 END) AS debit,
      SUM(CASE WHEN t.credit > 0 THEN t.credit ELSE 0 END) AS credit

    FROM transactions t
    JOIN accounts a
      ON a.account_code = t.account_code
     AND a.company_code = t.company_code

    WHERE t.company_code = ?
      AND t.account_code != ?   -- ❌ CASH remove
      AND (
        t.voucher_no LIKE ?
        OR a.name LIKE ?
        OR t.description LIKE ?
        OR t.reference LIKE ?
      )

    GROUP BY t.voucher_no
    ORDER BY MAX(t.date) DESC
    LIMIT 100
  `, [
    company_code,
    CASH,
    `%${query}%`,
    `%${query}%`,
    `%${query}%`,
    `%${query}%`
  ]);

  const vouchers = rows.map(r => ({
    ...r
  }));

  res.render('search-results', {
    vouchers,
    message: rows.length ? null : 'Transaction not found',
    query
  });
});

app.get('/gl/edit-transaction/:voucher_no', isAuthenticated, async (req, res) => {
  const { voucher_no } = req.params;
  const company_code = req.session.user.company_code;

  // 🔥 GET CASH ACCOUNT
  const [[settings]] = await db.query(
    "SELECT cash_account_code FROM company_settings WHERE company_code=?",
    [company_code]
  );

  const CASH = settings.cash_account_code;

  // 🔥 GET BOTH ENTRIES
  const [rows] = await db.query(`
    SELECT *
    FROM transactions
    WHERE voucher_no = ?
      AND company_code = ?
  `, [voucher_no, company_code]);

  if (!rows.length) {
    return res.status(404).send("Voucher not found");
  }

  // 🔥 FIND PARTY ENTRY (non-cash)
  const party = rows.find(r => r.account_code !== CASH);

  const editData = {
    voucher_no,
    date: party.date,
    account_code: party.account_code,
    serial_no: party.serial_no,
    description: party.description,
    reference: party.reference,
    invoice: party.invoice,
    amount: party.debit > 0 ? party.debit : party.credit,
    voucher_type: party.voucher_type
  };

  const [accounts] = await db.query(
    `SELECT account_code, name FROM accounts WHERE company_code = ?`,
    [company_code]
  );

  res.render('gl/add-transaction', {
    editData,
    accounts,
    settings,
    voucher_type: editData.voucher_type,
    entry_type: 'CB'
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