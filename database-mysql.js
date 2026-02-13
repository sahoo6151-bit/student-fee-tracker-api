const mysql = require('mysql2');
require('dotenv').config();

let pool;

// ================= CONNECT =================
const connectMySQL = async () => {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.MYSQL_HOST,
      port: process.env.MYSQL_PORT,
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE,
      waitForConnections: true,
      connectionLimit: 10,
    });

    console.log('✅ MySQL Pool Created');
    //console.log(process.env.MYSQL_USER, process.env.MYSQL_PASSWORD);
  }
};

// ================= SIMPLE QUERY =================
const mysqlQuery = async (query, params = []) => {
  if (!pool) await connectMySQL();
  const [rows] = await pool.promise().query(query, params);
  return rows;
};

// ================= TRANSACTION =================
const mysqlTransaction = async (callback) => {
  if (!pool) await connectMySQL();

  const connection = await pool.promise().getConnection();

  try {
    await connection.beginTransaction();

    const result = await callback(connection);

    await connection.commit();
    connection.release();
    return result;

  } catch (err) {
    await connection.rollback();
    connection.release();
    throw err;
  }
};

// 🚀 EXPORT ALL 3
module.exports = {
  connectMySQL,
  mysqlQuery,
  mysqlTransaction
};
