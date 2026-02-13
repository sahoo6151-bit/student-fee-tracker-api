const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const logger = require('./config/logger');
require('dotenv').config();

const { connectMySQL, mysqlQuery, mysqlTransaction } = require('./config/database-mysql');

const app = express();

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'b3ad834a909842e9f6d755b5fa8c2a261b54fa89d0a3e6052df569aa58b2896058105747f1e014ac0c9357ac44457ad8f50020fd991c3a1b025a80c72dcd255c';
const JWT_EXPIRE = process.env.JWT_EXPIRE || '7d';

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

const stream = {
  write: (message) => logger.info(message.trim())
};

// Error handling wrapper
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

app.use(morgan(
  ':method :url :status :res[content-length] - :response-time ms',
  { stream }
));

app.use((req, res, next) => {
  logger.info(`REQUEST → ${req.method} ${req.url} | Body: ${JSON.stringify(req.body)}`);

  const oldSend = res.send;
  res.send = function (data) {
    logger.info(`RESPONSE → ${req.method} ${req.url} | Status: ${res.statusCode} | Body: ${data}`);
    oldSend.apply(res, arguments);
  };

  next();
});

app.use((err, req, res, next) => {
  logger.error(`ERROR → ${req.method} ${req.url} - ${err.stack}`);
  res.status(500).json({ error: false, message: err.message });
});

// ==================== STATISTICS ENDPOINTS ====================

app.get('/api/statistics', asyncHandler(async (req, res) => {
  const { academicYear } = req.query;
  
  let query = `
    SELECT 
      COUNT(*) as total_students,
      COALESCE(SUM(total_fee), 0) as total_fee_expected,
      COALESCE(SUM(paid_amount), 0) as total_fee_collected,
      COALESCE(SUM(discount), 0) as total_discount,
      COALESCE(SUM(balance), 0) as total_pending,
      COUNT(CASE WHEN status = 'paid' THEN 1 END) as students_paid,
      COUNT(CASE WHEN status = 'partial' THEN 1 END) as students_partial,
      COUNT(CASE WHEN status = 'pending' THEN 1 END) as students_pending,
      COUNT(CASE WHEN status = 'overdue' THEN 1 END) as students_overdue
    FROM students
    WHERE is_active = true
  `;
  
  const params = [];
  if (academicYear) {
    query += ' AND academic_year = ?';
    params.push(academicYear);
  }

  const results = await mysqlQuery(query, params);
  const stats = results[0];

  const collectionRate = stats.total_fee_expected > 0
    ? ((stats.total_fee_collected / stats.total_fee_expected) * 100).toFixed(2)
    : 0;

  res.json({
    success: true,
    data: {
      totalStudents: parseInt(stats.total_students),
      totalFeeExpected: parseFloat(stats.total_fee_expected),
      totalFeeCollected: parseFloat(stats.total_fee_collected),
      totalDiscount: parseFloat(stats.total_discount),
      totalPending: parseFloat(stats.total_pending),
      collectionRate,
      studentsByStatus: {
        paid: parseInt(stats.students_paid),
        partial: parseInt(stats.students_partial),
        pending: parseInt(stats.students_pending),
        overdue: parseInt(stats.students_overdue)
      }
    }
  });
}));

app.get('/api/statistics/by-class', asyncHandler(async (req, res) => {
  const { academicYear } = req.query;
  
  let query = `
    SELECT 
      class,
      COUNT(*) as total_students,
      COALESCE(SUM(total_fee), 0) as total_fee,
      COALESCE(SUM(paid_amount), 0) as total_paid,
      COALESCE(SUM(discount), 0) as total_discount,
      COALESCE(SUM(balance), 0) as total_pending,
      COUNT(CASE WHEN status = 'paid' THEN 1 END) as paid_count,
      COUNT(CASE WHEN status = 'partial' THEN 1 END) as partial_count,
      COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_count
    FROM students
    WHERE is_active = true
  `;
  
  const params = [];
  if (academicYear) {
    query += ' AND academic_year = ?';
    params.push(academicYear);
  }
  
  query += ' GROUP BY class ORDER BY class';

  const results = await mysqlQuery(query, params);

  const data = results.map(row => ({
    class: row.class,
    totalStudents: parseInt(row.total_students),
    totalFee: parseFloat(row.total_fee),
    totalPaid: parseFloat(row.total_paid),
    totalDiscount: parseFloat(row.total_discount),
    totalPending: parseFloat(row.total_pending),
    collectionRate: row.total_fee > 0
      ? ((row.total_paid / row.total_fee) * 100).toFixed(2)
      : 0,
    paidCount: parseInt(row.paid_count),
    partialCount: parseInt(row.partial_count),
    pendingCount: parseInt(row.pending_count)
  }));

  res.json({
    success: true,
    data
  });
}));

// ==================== STUDENT ENDPOINTS ====================

app.get('/api/students', asyncHandler(async (req, res) => {
  const { status, class: studentClass, search, academicYear, page = 1, limit = 50 } = req.query;
  
  let query = 'SELECT * FROM students WHERE is_active = true';
  const params = [];

  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }

  if (studentClass) {
    query += ' AND class = ?';
    params.push(studentClass);
  }

  if (academicYear) {
    query += ' AND academic_year = ?';
    params.push(academicYear);
  }

  if (search) {
    query += ' AND (name LIKE ? OR email LIKE ? OR roll_number LIKE ?)';
    const searchTerm = `%${search}%`;
    params.push(searchTerm, searchTerm, searchTerm);
  }

  // Count total
  const countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as count');
  const countResult = await mysqlQuery(countQuery, params);
  const total = parseInt(countResult[0].count);

  // Add pagination
  const offset = (parseInt(page) - 1) * parseInt(limit);
  query += ' ORDER BY name LIMIT ? OFFSET ?';
  params.push(parseInt(limit), offset);

  const results = await mysqlQuery(query, params);

  res.json({
    success: true,
    count: results.length,
    total,
    page: parseInt(page),
    pages: Math.ceil(total / parseInt(limit)),
    data: results
  });
}));

app.get('/api/students/:id', asyncHandler(async (req, res) => {
  const studentQuery = 'SELECT * FROM students WHERE id = ?';
  const studentResult = await mysqlQuery(studentQuery, [req.params.id]);

  if (studentResult.length === 0) {
    return res.status(404).json({
      success: false,
      message: 'Student not found'
    });
  }

  const paymentsQuery = `
    SELECT * FROM payments 
    WHERE student_id = ? 
    ORDER BY payment_date DESC
  `;
  const paymentsResult = await mysqlQuery(paymentsQuery, [req.params.id]);

  res.json({
    success: true,
    data: {
      ...studentResult[0],
      payments: paymentsResult
    }
  });
}));

app.post('/api/students', asyncHandler(async (req, res) => {
  const {
    name,
    email,
    class: studentClass,
    rollNumber,
    phoneNumber,
    parentName,
    parentPhone,
    address,
    dateOfBirth,
    gender,
    totalFee,
    discount,
    academicYear
  } = req.body;

  // Generate student ID
  const countResult = await mysqlQuery('SELECT COUNT(*) as count FROM students');
  const count = parseInt(countResult[0].count);
  const studentId = `STU${new Date().getFullYear()}${String(count + 1).padStart(5, '0')}`;

  const currentYear = new Date().getFullYear();
  const defaultAcademicYear = academicYear || `${currentYear}-${currentYear + 1}`;

  const query = `
    INSERT INTO students (
      student_id, name, email, class, roll_number, phone_number,
      parent_name, parent_phone, address, date_of_birth, gender,
      total_fee, discount, academic_year
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const params = [
    studentId, name, email, studentClass, rollNumber, phoneNumber,
    parentName, parentPhone, address, dateOfBirth, gender,
    totalFee || 0, discount || 0, defaultAcademicYear
  ];

  const result = await mysqlQuery(query, params);

  // Fetch the created student
  const newStudent = await mysqlQuery('SELECT * FROM students WHERE id = ?', [result.insertId]);

  res.status(201).json({
    success: true,
    message: 'Student created successfully',
    data: newStudent[0]
  });
}));

app.put('/api/students/:id', asyncHandler(async (req, res) => {
  const allowedFields = [
    'name', 'email', 'class', 'roll_number', 'phone_number',
    'parent_name', 'parent_phone', 'address', 'date_of_birth',
    'gender', 'total_fee', 'discount', 'is_active'
  ];

  const updates = [];
  const params = [];

  Object.keys(req.body).forEach(key => {
    const dbKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    if (allowedFields.includes(dbKey)) {
      updates.push(`${dbKey} = ?`);
      params.push(req.body[key]);
    }
  });

  if (updates.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'No valid fields to update'
    });
  }

  params.push(req.params.id);

  const query = `
    UPDATE students 
    SET ${updates.join(', ')}
    WHERE id = ?
  `;

  await mysqlQuery(query, params);

  const updatedStudent = await mysqlQuery('SELECT * FROM students WHERE id = ?', [req.params.id]);

  if (updatedStudent.length === 0) {
    return res.status(404).json({
      success: false,
      message: 'Student not found'
    });
  }

  res.json({
    success: true,
    message: 'Student updated successfully',
    data: updatedStudent[0]
  });
}));

app.delete('/api/students/:id', asyncHandler(async (req, res) => {
  const result = await mysqlQuery('DELETE FROM students WHERE id = ?', [req.params.id]);

  if (result.affectedRows === 0) {
    return res.status(404).json({
      success: false,
      message: 'Student not found'
    });
  }

  res.json({
    success: true,
    message: 'Student and associated payments deleted successfully'
  });
}));

// ==================== PAYMENT ENDPOINTS ====================

app.get('/api/payments', asyncHandler(async (req, res) => {
  const { studentId, academicYear, paymentMethod, startDate, endDate, page = 1, limit = 50 } = req.query;
  
  let query = `
    SELECT p.*, s.name as student_name, s.class, s.roll_number
    FROM payments p
    JOIN students s ON p.student_id = s.id
    WHERE 1=1
  `;
  
  const params = [];

  if (studentId) {
    query += ' AND p.student_id = ?';
    params.push(studentId);
  }

  if (academicYear) {
    query += ' AND p.academic_year = ?';
    params.push(academicYear);
  }

  if (paymentMethod) {
    query += ' AND p.payment_method = ?';
    params.push(paymentMethod);
  }

  if (startDate) {
    query += ' AND p.payment_date >= ?';
    params.push(startDate);
  }

  if (endDate) {
    query += ' AND p.payment_date <= ?';
    params.push(endDate);
  }

  // Count total
  const countQuery = query.replace('SELECT p.*, s.name as student_name, s.class, s.roll_number', 'SELECT COUNT(*) as count');
  const countResult = await mysqlQuery(countQuery, params);
  const total = parseInt(countResult[0].count);

  // Add pagination
  const offset = (parseInt(page) - 1) * parseInt(limit);
  query += ' ORDER BY p.payment_date DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), offset);

  const results = await mysqlQuery(query, params);

  res.json({
    success: true,
    count: results.length,
    total,
    page: parseInt(page),
    pages: Math.ceil(total / parseInt(limit)),
    data: results
  });
}));

app.get('/api/payments/:id', asyncHandler(async (req, res) => {
  const query = `
    SELECT p.*, s.name as student_name, s.email, s.class, s.roll_number, s.balance
    FROM payments p
    JOIN students s ON p.student_id = s.id
    WHERE p.id = ?
  `;
  
  const results = await mysqlQuery(query, [req.params.id]);

  if (results.length === 0) {
    return res.status(404).json({
      success: false,
      message: 'Payment not found'
    });
  }

  res.json({
    success: true,
    data: results[0]
  });
}));

app.post('/api/payments', asyncHandler(async (req, res) => {
  const {
    studentId,
    amount,
    paymentDate,
    paymentMethod,
    transactionId,
    chequeNumber,
    bankName,
    remarks,
    receivedBy
  } = req.body;

  // Use transaction for payment creation
  const result = await mysqlTransaction(async (connection) => {
    // Check student exists and get balance
    const [studentRows] = await connection.query(
      'SELECT * FROM students WHERE id = ? FOR UPDATE',
      [studentId]
    );

    if (studentRows.length === 0) {
      throw new Error('Student not found');
    }

    const student = studentRows[0];
    const paymentAmount = parseFloat(amount);

    if (paymentAmount <= 0) {
      throw new Error('Payment amount must be greater than 0');
    }

    if (paymentAmount > student.balance) {
      throw new Error(`Payment amount (${paymentAmount}) exceeds student balance (${student.balance})`);
    }

    // Insert payment (receipt number will be auto-generated by trigger)
    const insertQuery = `
      INSERT INTO payments (
        student_id, amount, payment_date, payment_method,
        transaction_id, cheque_number, bank_name, remarks,
        received_by, academic_year
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const paymentParams = [
      studentId,
      paymentAmount,
      paymentDate || new Date().toISOString().split('T')[0],
      paymentMethod,
      transactionId,
      chequeNumber,
      bankName,
      remarks,
      receivedBy,
      student.academic_year
    ];

    const [paymentResult] = await connection.query(insertQuery, paymentParams);

    // Get the inserted payment
    const [paymentRows] = await connection.query(
      'SELECT * FROM payments WHERE id = ?',
      [paymentResult.insertId]
    );

    // Get updated student balance (after trigger execution)
    const [updatedStudentRows] = await connection.query(
      'SELECT balance FROM students WHERE id = ?',
      [studentId]
    );

    return {
      payment: paymentRows[0],
      studentBalance: updatedStudentRows[0].balance
    };
  });

  res.status(201).json({
    success: true,
    message: 'Payment recorded successfully',
    data: result.payment,
    studentBalance: result.studentBalance
  });
}));

app.put('/api/payments/:id', asyncHandler(async (req, res) => {
  const allowedFields = ['remarks', 'received_by', 'status', 'payment_date'];
  
  const updates = [];
  const params = [];

  Object.keys(req.body).forEach(key => {
    const dbKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    if (allowedFields.includes(dbKey)) {
      updates.push(`${dbKey} = ?`);
      params.push(req.body[key]);
    }
  });

  if (updates.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'No valid fields to update'
    });
  }

  params.push(req.params.id);

  const query = `UPDATE payments SET ${updates.join(', ')} WHERE id = ?`;
  await mysqlQuery(query, params);

  const updatedPayment = await mysqlQuery('SELECT * FROM payments WHERE id = ?', [req.params.id]);

  if (updatedPayment.length === 0) {
    return res.status(404).json({
      success: false,
      message: 'Payment not found'
    });
  }

  res.json({
    success: true,
    message: 'Payment updated successfully',
    data: updatedPayment[0]
  });
}));

app.delete('/api/payments/:id', asyncHandler(async (req, res) => {
  const result = await mysqlQuery('DELETE FROM payments WHERE id = ?', [req.params.id]);

  if (result.affectedRows === 0) {
    return res.status(404).json({
      success: false,
      message: 'Payment not found'
    });
  }

  res.json({
    success: true,
    message: 'Payment deleted and amount refunded to student balance'
  });
}));

// ==================== FEE STRUCTURE ENDPOINTS ====================

app.get('/api/fee-structures', asyncHandler(async (req, res) => {
  const { academicYear, class: className } = req.query;
  
  let query = 'SELECT * FROM fee_structures WHERE is_active = true';
  const params = [];

  if (academicYear) {
    query += ' AND academic_year = ?';
    params.push(academicYear);
  }

  if (className) {
    query += ' AND class = ?';
    params.push(className);
  }

  query += ' ORDER BY class';

  const results = await mysqlQuery(query, params);

  res.json({
    success: true,
    count: results.length,
    data: results
  });
}));

app.post('/api/fee-structures', asyncHandler(async (req, res) => {
  const {
    class: className,
    academicYear,
    tuitionFee,
    admissionFee,
    examFee,
    libraryFee,
    sportsFee,
    labFee,
    transportFee,
    otherFees
  } = req.body;

  const query = `
    INSERT INTO fee_structures (
      class, academic_year, tuition_fee, admission_fee, exam_fee,
      library_fee, sports_fee, lab_fee, transport_fee, other_fees
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const params = [
    className, academicYear, tuitionFee || 0, admissionFee || 0,
    examFee || 0, libraryFee || 0, sportsFee || 0, labFee || 0,
    transportFee || 0, otherFees || 0
  ];

  const result = await mysqlQuery(query, params);
  const newFeeStructure = await mysqlQuery('SELECT * FROM fee_structures WHERE id = ?', [result.insertId]);

  res.status(201).json({
    success: true,
    message: 'Fee structure created successfully',
    data: newFeeStructure[0]
  });
}));

// ==================== REPORTS ENDPOINTS ====================

app.get('/api/reports/defaulters', asyncHandler(async (req, res) => {
  const { academicYear, minBalance = 0 } = req.query;
  
  let query = `
    SELECT id, student_id, name, email, class, roll_number, parent_phone,
           total_fee, paid_amount, balance, status
    FROM students
    WHERE balance > ? AND status IN ('pending', 'partial', 'overdue')
  `;
  
  const params = [parseFloat(minBalance)];
  
  if (academicYear) {
    query += ' AND academic_year = ?';
    params.push(academicYear);
  }
  
  query += ' ORDER BY balance DESC';

  const results = await mysqlQuery(query, params);

  res.json({
    success: true,
    count: results.length,
    data: results
  });
}));

app.get('/api/reports/payment-history', asyncHandler(async (req, res) => {
  const { startDate, endDate, academicYear } = req.query;
  
  let query = `
    SELECT p.*, s.name as student_name, s.class, s.roll_number
    FROM payments p
    JOIN students s ON p.student_id = s.id
    WHERE p.status = 'completed'
  `;
  
  const params = [];

  if (startDate) {
    query += ' AND p.payment_date >= ?';
    params.push(startDate);
  }

  if (endDate) {
    query += ' AND p.payment_date <= ?';
    params.push(endDate);
  }

  if (academicYear) {
    query += ' AND p.academic_year = ?';
    params.push(academicYear);
  }

  query += ' ORDER BY p.payment_date DESC';

  const results = await mysqlQuery(query, params);
  const totalAmount = results.reduce((sum, p) => sum + parseFloat(p.amount), 0);

  res.json({
    success: true,
    count: results.length,
    totalAmount,
    data: results
  });
}));

// ==================== AUTHENTICATION MIDDLEWARE ====================

// Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Access denied. No token provided.'
    });
  }

  try {
    const verified = jwt.verify(token, JWT_SECRET);
    req.user = verified;
    next();
  } catch (error) {
    return res.status(403).json({
      success: false,
      message: 'Invalid or expired token'
    });
  }
};

// Middleware to check user role
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden. Insufficient permissions.'
      });
    }

    next();
  };
};

// ==================== AUTHENTICATION ROUTES ====================

// Login endpoint
app.post('/api/auth/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      message: 'Username and password are required'
    });
  }

  // Find user by username or email
  const query = `
    SELECT id, username, email, password_hash, full_name, role, is_active
    FROM users
    WHERE (username = ? OR email = ?) AND is_active = true
  `;
  
  const users = await mysqlQuery(query, [username, username]);

  if (users.length === 0) {
    return res.status(401).json({
      success: false,
      message: 'Invalid credentials'
    });
  }

  const user = users[0];

  // Verify password
  const validPassword = await bcrypt.compare(password, user.password_hash);

  if (!validPassword) {
    return res.status(401).json({
      success: false,
      message: 'Invalid credentials'
    });
  }

  // Generate JWT token
  const token = jwt.sign(
    {
      id: user.id,
      username: user.username,
      role: user.role
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRE }
  );

  // Return user data and token
  res.json({
    success: true,
    message: 'Login successful',
    token,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      fullName: user.full_name,
      role: user.role
    }
  });
  logger.info(res.json.message);
}));

// Get current user profile
app.get('/api/auth/me', authenticateToken, asyncHandler(async (req, res) => {
  const query = `
    SELECT id, username, email, full_name, role, created_at
    FROM users
    WHERE id = ?
  `;
  
  const users = await mysqlQuery(query, [req.user.id]);

  if (users.length === 0) {
    return res.status(404).json({
      success: false,
      message: 'User not found'
    });
  }

  res.json({
    success: true,
    data: users[0]
  });
}));

// Change password
app.post('/api/auth/change-password', authenticateToken, asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({
      success: false,
      message: 'Current password and new password are required'
    });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({
      success: false,
      message: 'New password must be at least 6 characters long'
    });
  }

  // Get current password hash
  const query = 'SELECT password_hash FROM users WHERE id = ?';
  const users = await mysqlQuery(query, [req.user.id]);

  if (users.length === 0) {
    return res.status(404).json({
      success: false,
      message: 'User not found'
    });
  }

  // Verify current password
  const validPassword = await bcrypt.compare(currentPassword, users[0].password_hash);

  if (!validPassword) {
    return res.status(401).json({
      success: false,
      message: 'Current password is incorrect'
    });
  }

  // Hash new password
  const salt = await bcrypt.genSalt(10);
  const newPasswordHash = await bcrypt.hash(newPassword, salt);

  // Update password
  const updateQuery = 'UPDATE users SET password_hash = ? WHERE id = ?';
  await mysqlQuery(updateQuery, [newPasswordHash, req.user.id]);

  res.json({
    success: true,
    message: 'Password changed successfully'
  });
}));

// Logout (client-side only, just clear token)
app.post('/api/auth/logout', authenticateToken, (req, res) => {
  res.json({
    success: true,
    message: 'Logged out successfully'
  });
});

// Register new user (admin only)
app.post('/api/auth/register', authenticateToken, authorize('admin'), asyncHandler(async (req, res) => {
  const { username, email, password, fullName, role } = req.body;

  if (!username || !email || !password || !fullName) {
    return res.status(400).json({
      success: false,
      message: 'All fields are required'
    });
  }

  if (password.length < 6) {
    return res.status(400).json({
      success: false,
      message: 'Password must be at least 6 characters long'
    });
  }

  // Check if username or email already exists
  const checkQuery = 'SELECT id FROM users WHERE username = ? OR email = ?';
  const existing = await mysqlQuery(checkQuery, [username, email]);

  if (existing.length > 0) {
    return res.status(400).json({
      success: false,
      message: 'Username or email already exists'
    });
  }

  // Hash password
  const salt = await bcrypt.genSalt(10);
  const passwordHash = await bcrypt.hash(password, salt);

  // Insert new user
  const insertQuery = `
    INSERT INTO users (username, email, password_hash, full_name, role)
    VALUES (?, ?, ?, ?, ?)
  `;

  const result = await mysqlQuery(insertQuery, [
    username,
    email,
    passwordHash,
    fullName,
    role || 'staff'
  ]);

  res.status(201).json({
    success: true,
    message: 'User registered successfully',
    userId: result.insertId
  });
}));

// Check if username exists (public endpoint for registration validation)
app.get('/api/auth/check-username/:username', asyncHandler(async (req, res) => {
  const { username } = req.params;

  const query = 'SELECT id FROM users WHERE username = ?';
  const results = await mysqlQuery(query, [username]);

  res.json({
    success: true,
    exists: results.length > 0,
    available: results.length === 0
  });
}));

// Check if email exists (public endpoint for registration validation)
app.get('/api/auth/check-email/:email', asyncHandler(async (req, res) => {
  const { email } = req.params;

  const query = 'SELECT id FROM users WHERE email = ?';
  const results = await mysqlQuery(query, [email]);

  res.json({
    success: true,
    exists: results.length > 0,
    available: results.length === 0
  });
}));

// Get all users (admin only)
app.get('/api/users', authenticateToken, authorize('admin'), asyncHandler(async (req, res) => {
  const query = `
    SELECT id, username, email, full_name, role, is_active, created_at
    FROM users
    ORDER BY created_at DESC
  `;
  
  const users = await mysqlQuery(query);

  res.json({
    success: true,
    count: users.length,
    data: users
  });
}));

// Update user (admin only)
app.put('/api/users/:id', authenticateToken, authorize('admin'), asyncHandler(async (req, res) => {
  const { fullName, role, isActive } = req.body;

  const updates = [];
  const params = [];

  if (fullName) {
    updates.push('full_name = ?');
    params.push(fullName);
  }
  if (role) {
    updates.push('role = ?');
    params.push(role);
  }
  if (isActive !== undefined) {
    updates.push('is_active = ?');
    params.push(isActive);
  }

  if (updates.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'No fields to update'
    });
  }

  params.push(req.params.id);

  const query = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;
  await mysqlQuery(query, params);

  res.json({
    success: true,
    message: 'User updated successfully'
  });
}));

// Delete user (admin only)
app.delete('/api/users/:id', authenticateToken, authorize('admin'), asyncHandler(async (req, res) => {
  // Prevent deleting yourself
  if (parseInt(req.params.id) === req.user.id) {
    return res.status(400).json({
      success: false,
      message: 'You cannot delete your own account'
    });
  }

  const query = 'DELETE FROM users WHERE id = ?';
  await mysqlQuery(query, [req.params.id]);

  res.json({
    success: true,
    message: 'User deleted successfully'
  });
}));

// ==================== PROTECT EXISTING ROUTES (OPTIONAL) ====================

// Example: Protect student creation (only authenticated users can create students)
// Replace the existing POST /api/students route with this:
/*
app.post('/api/students', authenticateToken, asyncHandler(async (req, res) => {
  // ... existing student creation code ...
}));
*/

// Example: Only admins can delete students
/*
app.delete('/api/students/:id', authenticateToken, authorize('admin'), asyncHandler(async (req, res) => {
  // ... existing delete code ...
}));
*/

// Export middleware for use in other files
module.exports = {
  authenticateToken,
  authorize
};

// ==================== USER DETAILS ENDPOINTS ====================

// Get user by username (requires authentication)
app.get('/api/users/username/:username', authenticateToken, asyncHandler(async (req, res) => {
  const { username } = req.params;

  const query = `
    SELECT id, username, email, full_name, role, is_active, created_at, updated_at
    FROM users
    WHERE username = ?
  `;
  
  const results = await mysqlQuery(query, [username]);

  if (results.length === 0) {
    return res.status(404).json({
      success: false,
      message: 'User not found'
    });
  }

  // Check if requesting own data or if admin
  const requestingUser = req.user;
  const targetUser = results[0];

  // Allow if:
  // 1. User is admin, OR
  // 2. User is requesting their own data
  if (requestingUser.role !== 'admin' && requestingUser.username !== username) {
    return res.status(403).json({
      success: false,
      message: 'You can only view your own profile or must be admin'
    });
  }

  res.json({
    success: true,
    data: targetUser
  });
}));

// Get user by email (requires authentication, admin only)
app.get('/api/users/email/:email', authenticateToken, authorize('admin'), asyncHandler(async (req, res) => {
  const { email } = req.params;

  const query = `
    SELECT id, username, email, full_name, role, is_active, created_at, updated_at
    FROM users
    WHERE email = ?
  `;
  
  const results = await mysqlQuery(query, [email]);

  if (results.length === 0) {
    return res.status(404).json({
      success: false,
      message: 'User not found'
    });
  }

  res.json({
    success: true,
    data: results[0]
  });
}));

// Get user by ID (requires authentication)
app.get('/api/users/:id', authenticateToken, asyncHandler(async (req, res) => {
  const { id } = req.params;

  const query = `
    SELECT id, username, email, full_name, role, is_active, created_at, updated_at
    FROM users
    WHERE id = ?
  `;
  
  const results = await mysqlQuery(query, [id]);

  if (results.length === 0) {
    return res.status(404).json({
      success: false,
      message: 'User not found'
    });
  }

  // Check permissions
  const requestingUser = req.user;
  const targetUser = results[0];

  if (requestingUser.role !== 'admin' && requestingUser.id !== parseInt(id)) {
    return res.status(403).json({
      success: false,
      message: 'You can only view your own profile or must be admin'
    });
  }

  res.json({
    success: true,
    data: targetUser
  });
}));

// Search users by name or username (admin only)
app.get('/api/users/search/:query', authenticateToken, authorize('admin'), asyncHandler(async (req, res) => {
  const { query: searchQuery } = req.params;

  const query = `
    SELECT id, username, email, full_name, role, is_active, created_at
    FROM users
    WHERE username LIKE ? OR full_name LIKE ? OR email LIKE ?
    ORDER BY username
    LIMIT 20
  `;
  
  const searchTerm = `%${searchQuery}%`;
  const results = await mysqlQuery(query, [searchTerm, searchTerm, searchTerm]);

  res.json({
    success: true,
    count: results.length,
    data: results
  });
}));

// ==================== FEE STRUCTURE ENDPOINTS ====================

// Get all fee structures with filtering
app.get('/api/fee-structures', asyncHandler(async (req, res) => {
  const { academicYear, class: className, isActive } = req.query;
  
  let query = 'SELECT * FROM fee_structures WHERE 1=1';
  const params = [];

  if (academicYear) {
    query += ' AND academic_year = ?';
    params.push(academicYear);
  }

  if (className) {
    query += ' AND class = ?';
    params.push(className);
  }

  if (isActive !== undefined) {
    query += ' AND is_active = ?';
    params.push(isActive === 'true' ? 1 : 0);
  }

  query += ' ORDER BY class ASC';

  const results = await mysqlQuery(query, params);

  res.json({
    success: true,
    count: results.length,
    data: results
  });
}));

// Get single fee structure by ID
app.get('/api/fee-structures/:id', asyncHandler(async (req, res) => {
  const query = 'SELECT * FROM fee_structures WHERE id = ?';
  const results = await mysqlQuery(query, [req.params.id]);

  if (results.length === 0) {
    return res.status(404).json({
      success: false,
      message: 'Fee structure not found'
    });
  }

  res.json({
    success: true,
    data: results[0]
  });
}));

// Get fee structure by class and academic year
app.get('/api/fee-structures/class/:class/year/:year', asyncHandler(async (req, res) => {
  const query = 'SELECT * FROM fee_structures WHERE class = ? AND academic_year = ? AND is_active = true';
  const results = await mysqlQuery(query, [req.params.class, req.params.year]);

  if (results.length === 0) {
    return res.status(404).json({
      success: false,
      message: 'Fee structure not found for this class and year'
    });
  }

  res.json({
    success: true,
    data: results[0]
  });
}));

// Create new fee structure
app.post('/api/fee-structures', asyncHandler(async (req, res) => {
  const {
    class: className,
    academicYear,
    tuitionFee,
    admissionFee,
    examFee,
    libraryFee,
    sportsFee,
    labFee,
    transportFee,
    otherFees,
    isActive
  } = req.body;

  // Validate required fields
  if (!className || !academicYear || tuitionFee === undefined) {
    return res.status(400).json({
      success: false,
      message: 'Class, academic year, and tuition fee are required'
    });
  }

  // Check if fee structure already exists for this class and year
  const checkQuery = 'SELECT id FROM fee_structures WHERE class = ? AND academic_year = ?';
  const existing = await mysqlQuery(checkQuery, [className, academicYear]);

  if (existing.length > 0) {
    return res.status(400).json({
      success: false,
      message: 'Fee structure already exists for this class and academic year'
    });
  }

  // Insert new fee structure
  const query = `
    INSERT INTO fee_structures (
      class, academic_year, tuition_fee, admission_fee, exam_fee,
      library_fee, sports_fee, lab_fee, transport_fee, other_fees, is_active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const params = [
    className,
    academicYear,
    tuitionFee,
    admissionFee || 0,
    examFee || 0,
    libraryFee || 0,
    sportsFee || 0,
    labFee || 0,
    transportFee || 0,
    otherFees || 0,
    isActive !== undefined ? isActive : true
  ];

  const result = await mysqlQuery(query, params);

  // Get the created fee structure
  const newFeeStructure = await mysqlQuery('SELECT * FROM fee_structures WHERE id = ?', [result.insertId]);

  res.status(201).json({
    success: true,
    message: 'Fee structure created successfully',
    data: newFeeStructure[0]
  });
}));

// Update fee structure
app.put('/api/fee-structures/:id', asyncHandler(async (req, res) => {
  const {
    class: className,
    academicYear,
    tuitionFee,
    admissionFee,
    examFee,
    libraryFee,
    sportsFee,
    labFee,
    transportFee,
    otherFees,
    isActive
  } = req.body;

  // Check if fee structure exists
  const checkQuery = 'SELECT id FROM fee_structures WHERE id = ?';
  const existing = await mysqlQuery(checkQuery, [req.params.id]);

  if (existing.length === 0) {
    return res.status(404).json({
      success: false,
      message: 'Fee structure not found'
    });
  }

  // Build update query
  const updates = [];
  const params = [];

  if (className !== undefined) {
    updates.push('class = ?');
    params.push(className);
  }
  if (academicYear !== undefined) {
    updates.push('academic_year = ?');
    params.push(academicYear);
  }
  if (tuitionFee !== undefined) {
    updates.push('tuition_fee = ?');
    params.push(tuitionFee);
  }
  if (admissionFee !== undefined) {
    updates.push('admission_fee = ?');
    params.push(admissionFee);
  }
  if (examFee !== undefined) {
    updates.push('exam_fee = ?');
    params.push(examFee);
  }
  if (libraryFee !== undefined) {
    updates.push('library_fee = ?');
    params.push(libraryFee);
  }
  if (sportsFee !== undefined) {
    updates.push('sports_fee = ?');
    params.push(sportsFee);
  }
  if (labFee !== undefined) {
    updates.push('lab_fee = ?');
    params.push(labFee);
  }
  if (transportFee !== undefined) {
    updates.push('transport_fee = ?');
    params.push(transportFee);
  }
  if (otherFees !== undefined) {
    updates.push('other_fees = ?');
    params.push(otherFees);
  }
  if (isActive !== undefined) {
    updates.push('is_active = ?');
    params.push(isActive);
  }

  if (updates.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'No fields to update'
    });
  }

  params.push(req.params.id);

  const query = `UPDATE fee_structures SET ${updates.join(', ')} WHERE id = ?`;
  await mysqlQuery(query, params);

  // Get updated fee structure
  const updatedFeeStructure = await mysqlQuery('SELECT * FROM fee_structures WHERE id = ?', [req.params.id]);

  res.json({
    success: true,
    message: 'Fee structure updated successfully',
    data: updatedFeeStructure[0]
  });
}));

// Delete fee structure
app.delete('/api/fee-structures/:id', asyncHandler(async (req, res) => {
  // Check if fee structure exists
  const checkQuery = 'SELECT id FROM fee_structures WHERE id = ?';
  const existing = await mysqlQuery(checkQuery, [req.params.id]);

  if (existing.length === 0) {
    return res.status(404).json({
      success: false,
      message: 'Fee structure not found'
    });
  }

  // Delete fee structure
  const query = 'DELETE FROM fee_structures WHERE id = ?';
  await mysqlQuery(query, [req.params.id]);

  res.json({
    success: true,
    message: 'Fee structure deleted successfully'
  });
}));

// Bulk activate/deactivate fee structures
app.post('/api/fee-structures/bulk-status', asyncHandler(async (req, res) => {
  const { ids, isActive } = req.body;

  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'IDs array is required'
    });
  }

  if (isActive === undefined) {
    return res.status(400).json({
      success: false,
      message: 'isActive status is required'
    });
  }

  const placeholders = ids.map(() => '?').join(',');
  const query = `UPDATE fee_structures SET is_active = ? WHERE id IN (${placeholders})`;
  const params = [isActive, ...ids];

  await mysqlQuery(query, params);

  res.json({
    success: true,
    message: `Fee structures ${isActive ? 'activated' : 'deactivated'} successfully`
  });
}));

// Copy fee structure to new academic year
app.post('/api/fee-structures/:id/copy', asyncHandler(async (req, res) => {
  const { newAcademicYear, increasePercentage } = req.body;

  if (!newAcademicYear) {
    return res.status(400).json({
      success: false,
      message: 'New academic year is required'
    });
  }

  // Get original fee structure
  const originalQuery = 'SELECT * FROM fee_structures WHERE id = ?';
  const original = await mysqlQuery(originalQuery, [req.params.id]);

  if (original.length === 0) {
    return res.status(404).json({
      success: false,
      message: 'Fee structure not found'
    });
  }

  const fee = original[0];
  const increase = parseFloat(increasePercentage) || 0;
  const multiplier = 1 + (increase / 100);

  // Check if fee structure already exists for new year
  const checkQuery = 'SELECT id FROM fee_structures WHERE class = ? AND academic_year = ?';
  const existing = await mysqlQuery(checkQuery, [fee.class, newAcademicYear]);

  if (existing.length > 0) {
    return res.status(400).json({
      success: false,
      message: 'Fee structure already exists for this class and academic year'
    });
  }

  // Create new fee structure with optional increase
  const insertQuery = `
    INSERT INTO fee_structures (
      class, academic_year, tuition_fee, admission_fee, exam_fee,
      library_fee, sports_fee, lab_fee, transport_fee, other_fees, is_active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const params = [
    fee.class,
    newAcademicYear,
    Math.round(fee.tuition_fee * multiplier),
    Math.round((fee.admission_fee || 0) * multiplier),
    Math.round((fee.exam_fee || 0) * multiplier),
    Math.round((fee.library_fee || 0) * multiplier),
    Math.round((fee.sports_fee || 0) * multiplier),
    Math.round((fee.lab_fee || 0) * multiplier),
    Math.round((fee.transport_fee || 0) * multiplier),
    Math.round((fee.other_fees || 0) * multiplier),
    true
  ];

  const result = await mysqlQuery(insertQuery, params);

  // Get the created fee structure
  const newFeeStructure = await mysqlQuery('SELECT * FROM fee_structures WHERE id = ?', [result.insertId]);

  res.status(201).json({
    success: true,
    message: 'Fee structure copied successfully',
    data: newFeeStructure[0]
  });
}));

// Get fee structure summary statistics
app.get('/api/fee-structures/statistics/summary', asyncHandler(async (req, res) => {
  const { academicYear } = req.query;

  let query = `
    SELECT 
      COUNT(*) as total_structures,
      COUNT(CASE WHEN is_active = true THEN 1 END) as active_structures,
      AVG(total_fee) as average_fee,
      MIN(total_fee) as min_fee,
      MAX(total_fee) as max_fee,
      SUM(total_fee) as total_fees
    FROM fee_structures
    WHERE 1=1
  `;

  const params = [];
  if (academicYear) {
    query += ' AND academic_year = ?';
    params.push(academicYear);
  }

  const results = await mysqlQuery(query, params);

  res.json({
    success: true,
    data: {
      totalStructures: parseInt(results[0].total_structures),
      activeStructures: parseInt(results[0].active_structures),
      averageFee: parseFloat(results[0].average_fee) || 0,
      minFee: parseFloat(results[0].min_fee) || 0,
      maxFee: parseFloat(results[0].max_fee) || 0,
      totalFees: parseFloat(results[0].total_fees) || 0
    }
  });
}));

// ==================== ERROR HANDLING ====================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

app.use((err, req, res, next) => {
  logger.error('Error:', err);

  if (err.code === 'ER_DUP_ENTRY') {
    return res.status(400).json({
      success: false,
      message: 'Duplicate entry',
      detail: err.sqlMessage
    });
  }

  if (err.code === 'ER_NO_REFERENCED_ROW_2') {
    return res.status(400).json({
      success: false,
      message: 'Referenced record not found'
    });
  }

  res.status(err.statusCode || 500).json({
    success: false,
    message: err.message || 'Internal server error'
  });
});

// ==================== SERVER START ====================

const PORT = process.env.PORT || 3000;

const startServer = async () => {
  try {
    await connectMySQL();
    
    app.listen(PORT, () => {
      logger.info(`🚀 Server running on port ${PORT}`);
      logger.info(`📊 API URL: http://localhost:${PORT}/api`);
      logger.info(`🔍 Database: MySQL`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

module.exports = app;
