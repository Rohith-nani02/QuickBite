
require("dotenv").config();

const mysql = require("mysql2");
const fs = require("fs");

const isAiven = Boolean(process.env.MYSQLHOST?.includes("aivencloud.com"));

const config = {
  host: process.env.MYSQLHOST || process.env.DB_HOST || "localhost",
  port: Number(process.env.MYSQLPORT || process.env.DB_PORT || 3306),
  user: process.env.MYSQLUSER || process.env.DB_USER || "root",
  password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD || "",
  database: process.env.MYSQLDATABASE || process.env.DB_NAME || "smart_canteen_db",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

if (isAiven) {
  const caPath = process.env.MYSQL_CA_PATH;

  if (!caPath || !fs.existsSync(caPath)) {
    throw new Error("Aiven CA certificate file is missing.");
  }

  config.ssl = {
    ca: fs.readFileSync(caPath, "utf8"),
    rejectUnauthorized: true
  };
}

const db = mysql.createPool(config);

db.getConnection((err, connection) => {
  if (err) {
    console.error("MySQL connection failed:", err.message);
    return;
  }

  console.log("QuickBite MySQL connection established successfully!");
  connection.release();
});

module.exports = db;
