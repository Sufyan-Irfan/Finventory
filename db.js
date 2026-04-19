// const mysql = require('mysql');

// const db = mysql.createConnection({
//     host: 'localhost',
//     user: 'root',
//     password: '',
//     database: 'inventory_management'
// });

// db.connect((err) => {
//     if (err) {
//         console.error('Database connection failed:', err.stack);
//         return;
//     }
//     console.log('Connected to MySQL');
// });

// module.exports = db;

// const mysql = require('mysql2');
// const pool = mysql.createPool({
//   host: 'localhost',
//   user: 'root',
//   password: '',
//   database: 'ledger_db'
// });
// module.exports = pool.promise();

require("dotenv").config();
const mysql = require("mysql2");

// Railway vs Local auto detect
const isRailway = process.env.MYSQLHOST !== undefined;

const db = mysql.createPool({
  host: isRailway ? process.env.MYSQLHOST : process.env.DB_HOST,
  user: isRailway ? process.env.MYSQLUSER : process.env.DB_USER,
  password: isRailway ? process.env.MYSQLPASSWORD : process.env.DB_PASSWORD,
  database: isRailway ? process.env.MYSQLDATABASE : process.env.DB_NAME,
  port: isRailway ? process.env.MYSQLPORT : process.env.DB_PORT,
  ssl: isRailway ? { rejectUnauthorized: false } : undefined,

  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 10000  // ← add this
});

// At the bottom of db.js, after module.exports
db.getConnection((err, connection) => {
  if (err) {
    console.error("❌ DB Connection Failed:", err.message);
  } else {
    console.log("✅ MySQL Connected Successfully");
    connection.release();
  }
});

module.exports = db.promise();