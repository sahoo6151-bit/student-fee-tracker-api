// Script to create initial admin user
// Run this once to create your first admin account

require('dotenv').config();
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

async function createAdminUser() {
  console.log('='.repeat(60));
  console.log('Create Admin User for Student Fee Tracking System');
  console.log('='.repeat(60));
  console.log();

  try {
    // Get user input
    const username = await question('Enter admin username: ');
    const email = await question('Enter admin email: ');
    const fullName = await question('Enter full name: ');
    const password = await question('Enter password (min 6 characters): ');

    if (!username || !email || !fullName || !password) {
      console.log('❌ All fields are required!');
      rl.close();
      return;
    }

    if (password.length < 6) {
      console.log('❌ Password must be at least 6 characters long!');
      rl.close();
      return;
    }

    console.log('\nConnecting to MySQL...');

    // Connect to database
    const connection = await mysql.createConnection({
      host: process.env.MYSQL_HOST || 'localhost',
      port: process.env.MYSQL_PORT || 3306,
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE || 'student_fee_tracker'
    });

    console.log('✅ Connected to MySQL');

    // Check if username or email already exists
    const [existing] = await connection.query(
      'SELECT id FROM users WHERE username = ? OR email = ?',
      [username, email]
    );

    if (existing.length > 0) {
      console.log('❌ Username or email already exists!');
      await connection.end();
      rl.close();
      return;
    }

    console.log('Hashing password...');

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    console.log('Creating admin user...');

    // Insert admin user
    const [result] = await connection.query(
      `INSERT INTO users (username, email, password_hash, full_name, role, is_active)
       VALUES (?, ?, ?, ?, 'admin', true)`,
      [username, email, passwordHash, fullName]
    );

    console.log();
    console.log('='.repeat(60));
    console.log('✅ Admin user created successfully!');
    console.log('='.repeat(60));
    console.log();
    console.log('Login Credentials:');
    console.log('  Username:', username);
    console.log('  Email:', email);
    console.log('  Password:', password);
    console.log('  Role: admin');
    console.log();
    console.log('User ID:', result.insertId);
    console.log();
    console.log('⚠️  Keep these credentials safe!');
    console.log('You can now log in at: http://localhost:3000/login.html');
    console.log();

    await connection.end();
    rl.close();

  } catch (error) {
    console.error('❌ Error creating admin user:');
    console.error(error.message);
    rl.close();
    process.exit(1);
  }
}

createAdminUser();
