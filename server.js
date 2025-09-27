require("dotenv").config();
const twilio = require('twilio');
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhone = process.env.TWILIO_PHONE_NUMBER;
const twilioClient = twilio(accountSid, authToken);

const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;
const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: true, // true for 465, false for others
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Constants
const LOW_STOCK_CHECK_INTERVAL = 3600000; // 1 hour in milliseconds

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get("/", (req, res) => {
  res.json({ 
    status: "Server is running",
    timestamp: new Date().toISOString(),
    port: PORT 
  });
});

app.get("/health", async (req, res) => {
  try {
    const connection = await pool.getConnection();
    connection.release();
    res.json({ 
      status: "healthy",
      database: "connected",
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      status: "unhealthy",
      database: "disconnected",
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// MySQL connection
const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
};

// Create connection pool
const pool = mysql.createPool(dbConfig);

// Enhanced transaction logging function - FIXED SYNTAX ERROR
async function logSystemTransaction(action, details, updatedBy = 'SYSTEM') {
  try {
    await pool.execute(
      `INSERT INTO transactions (stock_id, type, quantity, value, updated_by, transaction_date, notes) 
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
      [null, action, 0, 0.00, updatedBy, details]
    );
    console.log(`📝 System transaction logged: ${action} - ${details}`);
  } catch (error) {
    console.error('Transaction logging error:', error);
  }
}

// Enhanced stock transaction logging
async function logStockTransaction(stockId, type, quantity, value, updatedBy, notes = null) {
  try {
    await pool.execute(
      `INSERT INTO transactions (stock_id, type, quantity, value, updated_by, transaction_date, notes) 
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
      [stockId, type, quantity, value, updatedBy, notes]
    );
    console.log(`📝 Stock transaction logged: ${type} ${quantity} units (Value: ${value}) by ${updatedBy}`);
  } catch (error) {
    console.error('Stock transaction logging error:', error);
  }
}

// Improved SMS sending function
async function sendLowStockAlert(phone, message) {
  try {
    // Ensure phone number is properly formatted
    let formattedPhone = phone;
    if (!phone.startsWith('+')) {
      // Default to India country code if not specified
      formattedPhone = '+91' + phone.replace(/^\+?91?/, '');
    }
    
    const msg = await twilioClient.messages.create({
      body: message,
      from: twilioPhone,
      to: formattedPhone,
    });
    console.log(`SMS sent to ${formattedPhone}: ${msg.sid}`);
    
    // Log SMS transaction
    await logSystemTransaction('SMS_SENT', `Alert sent to ${formattedPhone}: ${message.substring(0, 100)}...`);
    return true;
  } catch (error) {
    console.error('Twilio SMS error:', error);
    await logSystemTransaction('SMS_FAILED', `Failed to send SMS to ${phone}: ${error.message}`);
    return false;
  }
}

// Low stock notification function
async function notifyLowStock() {
  console.log(`Checking for low stock items at ${new Date().toISOString()}`);
  
  try {
    // Log the check start
    await logSystemTransaction('LOW_STOCK_CHECK', 'Automated low stock check initiated');
    
    // 1. First find all low stock items
    const [lowStockItems] = await pool.execute(`
      SELECT 
        s.id, 
        s.item_name, 
        s.quantity, 
        s.threshold_value,
        s.department,
        CONCAT('+91', sup.phone_number) AS supervisor_phone
      FROM warehouse_stock.stock s
      JOIN warehouse_stock.operators sup ON sup.department = s.department AND sup.role = 'supervisor'
      WHERE s.quantity <= s.threshold_value
    `);

    if (lowStockItems.length === 0) {
      console.log('No low stock items found');
      await logSystemTransaction('LOW_STOCK_CHECK_COMPLETE', 'No low stock items found');
      return;
    }

    // Log low stock items found
    await logSystemTransaction('LOW_STOCK_DETECTED', `Found ${lowStockItems.length} low stock items: ${lowStockItems.map(item => item.item_name).join(', ')}`);

    // 2. Send SMS alerts to department supervisors
    const supervisorAlerts = {};
    lowStockItems.forEach(item => {
      if (!supervisorAlerts[item.supervisor_phone]) {
        supervisorAlerts[item.supervisor_phone] = {
          department: item.department,
          items: []
        };
      }
      supervisorAlerts[item.supervisor_phone].items.push(`${item.item_name} (${item.quantity}/${item.threshold_value})`);
    });

    for (const [phone, alert] of Object.entries(supervisorAlerts)) {
      const message = `LOW STOCK in ${alert.department}: ${alert.items.join(', ')}`;
      await sendLowStockAlert(phone, message);
    }

    // 3. Create admin requests for items that don't have pending requests
    const [adminUsers] = await pool.execute(`
      SELECT id, CONCAT('+91', phone_number) AS admin_phone 
      FROM warehouse_stock.operators 
      WHERE role = 'admin'
    `);

    if (adminUsers.length === 0) {
      console.error('No admin users found');
      await logSystemTransaction('LOW_STOCK_ERROR', 'No admin users found for request creation');
      return;
    }

    const primaryAdmin = adminUsers[0];
    const adminMessageItems = [];

    for (const item of lowStockItems) {
      // Check if request already exists
      const [existingRequest] = await pool.execute(`
        SELECT id FROM warehouse_stock.low_stock_requests 
        WHERE stock_id = ? AND status = 'PENDING'
      `, [item.id]);

      if (existingRequest.length === 0) {
        // Create new request
        await pool.execute(
          `INSERT INTO warehouse_stock.low_stock_requests 
           (stock_id, requested_by, status) 
           VALUES (?, ?, 'PENDING')`,
          [item.id, primaryAdmin.id]
        );
        adminMessageItems.push(`${item.item_name} (${item.department})`);
        console.log(`Created admin request for ${item.item_name}`);
        
        // Log request creation
        await logSystemTransaction('REQUEST_CREATED', `Auto-created low stock request for ${item.item_name} in ${item.department}`, 'SYSTEM');
      }
    }

    // 4. Notify admin about new requests if any were created
    if (adminMessageItems.length > 0) {
      const adminMessage = `NEW STOCK REQUESTS (${adminMessageItems.length}):\n${adminMessageItems.join('\n')}`;
      
      // Send to all admins
      for (const admin of adminUsers) {
        await sendLowStockAlert(admin.admin_phone, adminMessage);
      }
      
      await logSystemTransaction('ADMIN_NOTIFIED', `Notified ${adminUsers.length} admin(s) about ${adminMessageItems.length} new requests`);
    }

    await logSystemTransaction('LOW_STOCK_CHECK_COMPLETE', `Processed ${lowStockItems.length} low stock items, created ${adminMessageItems.length} new requests`);

  } catch (error) {
    console.error('Low stock notification error:', error);
    await logSystemTransaction('LOW_STOCK_ERROR', `Low stock check failed: ${error.message}`);
  }
}

// Start low stock monitoring
async function startLowStockMonitor() {
  console.log("Starting low stock monitor...");
  try {
    await logSystemTransaction('MONITOR_START', 'Low stock monitoring system started');
    await notifyLowStock(); // Run immediately on startup
    setInterval(notifyLowStock, LOW_STOCK_CHECK_INTERVAL); // Then run periodically
  } catch (error) {
    console.error("Low stock monitor error:", error);
    await logSystemTransaction('MONITOR_ERROR', `Monitor startup failed: ${error.message}`);
  }
}

// Test database connection
async function testConnection() {
  try {
    const connection = await pool.getConnection();
    console.log("✅ Connected to MySQL database");
    await logSystemTransaction('DB_CONNECT', 'Database connection established successfully');
    connection.release();
  } catch (error) {
    console.error("❌ Database connection failed:", error.message);
    // Can't log this one since DB is not connected
  }
}

// Login route with role-based authentication
app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  try {
    const [rows] = await pool.execute("SELECT * FROM operators WHERE username = ? AND password = ?", [
      username,
      password,
    ]);

    if (rows.length > 0) {
      const operator = rows[0];
      console.log(`✅ Login successful: ${operator.username} (${operator.role}) - Department: ${operator.department}`);

      // Log successful login
      await logSystemTransaction('USER_LOGIN', `User ${operator.username} (${operator.role}) logged in from ${operator.department}`, operator.username);

      res.json({
        success: true,
        operator: {
          id: operator.id,
          username: operator.username,
          role: operator.role,
          department: operator.department,
          phone_number: operator.phone_number
        },
      });
    } else {
      // Log failed login attempt
      await logSystemTransaction('LOGIN_FAILED', `Failed login attempt for username: ${username}`, 'SYSTEM');
      
      res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });
    }
  } catch (error) {
    console.error("Login error:", error);
    await logSystemTransaction('LOGIN_ERROR', `Login system error: ${error.message}`, 'SYSTEM');
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

// Logout route
app.post("/logout", async (req, res) => {
  const { username } = req.body;
  
  // Log logout
  await logSystemTransaction('USER_LOGOUT', `User ${username || 'unknown'} logged out`, username || 'SYSTEM');
  
  res.json({
    success: true,
    message: "Logged out successfully",
  })
})

// Get all operators with department filtering
app.get("/operators", async (req, res) => {
  const userRole = req.headers["user-role"]
  const userDepartment = req.headers["user-department"]
  const username = req.headers["user-name"] || 'unknown'

  // Check if user has permission
  if (userRole !== "admin" && userRole !== "supervisor") {
    await logSystemTransaction('ACCESS_DENIED', `${username} attempted to access operators list without permission`, username);
    return res.status(403).json({
      success: false,
      message: "Insufficient permissions. Only admin and supervisor can view operators.",
    })
  }

  try {
    let query = "SELECT id, username, role, department, created_at FROM operators"
    const params = []

    if (userRole === "admin") {
      // Admin can see all operators
      query += " ORDER BY department, role, created_at DESC"
    } else if (userRole === "supervisor") {
      // Supervisors can only see operators in their department
      query += ' WHERE role = "operator" AND department = ? ORDER BY created_at DESC'
      params.push(userDepartment)
    }

    const [rows] = await pool.execute(query, params)

    // Log access
    await logSystemTransaction('OPERATORS_ACCESSED', `${username} (${userRole}) viewed operators list - ${rows.length} records`, username);

    res.json({
      success: true,
      data: rows,
    })
  } catch (error) {
    console.error("Fetch operators error:", error)
    await logSystemTransaction('OPERATORS_ERROR', `Error fetching operators: ${error.message}`, username);
    res.status(500).json({
      success: false,
      message: "Failed to fetch operators",
    })
  }
})

// Add new operator with department
app.post("/operators", async (req, res) => {
  const { username, password, role, department, user_role, user_department } = req.body
  const updatedBy = req.headers["user-name"] || 'unknown'

  // Check if user has permission
  if (user_role !== "admin" && user_role !== "supervisor") {
    await logSystemTransaction('ACCESS_DENIED', `${updatedBy} attempted to create operator without permission`, updatedBy);
    return res.status(403).json({
      success: false,
      message: "Insufficient permissions. Only admin and supervisor can add operators.",
    })
  }

  // Supervisors can only create operators in their own department
  if (user_role === "supervisor") {
    if (role !== "operator") {
      await logSystemTransaction('ACCESS_DENIED', `${updatedBy} (supervisor) attempted to create non-operator account`, updatedBy);
      return res.status(403).json({
        success: false,
        message: "Supervisors can only create operator accounts.",
      })
    }
    if (department !== user_department) {
      await logSystemTransaction('ACCESS_DENIED', `${updatedBy} (supervisor) attempted to create operator in different department`, updatedBy);
      return res.status(403).json({
        success: false,
        message: "Supervisors can only create operators in their own department.",
      })
    }
  }

  // Validate department
  const validDepartments = ["Moulding", "Melting", "Grinding", "Inspection"]
  if (!validDepartments.includes(department)) {
    return res.status(400).json({
      success: false,
      message: "Invalid department. Must be one of: " + validDepartments.join(", "),
    })
  }

  try {
    // Check if username already exists
    const [existing] = await pool.execute("SELECT * FROM operators WHERE username = ?", [username])

    if (existing.length > 0) {
      await logSystemTransaction('OPERATOR_CREATE_FAILED', `${updatedBy} attempted to create duplicate username: ${username}`, updatedBy);
      return res.status(400).json({
        success: false,
        message: "Username already exists",
      })
    }

    // Insert new operator with department
    await pool.execute("INSERT INTO operators (username, password, role, department) VALUES (?, ?, ?, ?)", [
      username,
      password,
      role,
      department,
    ])

    // Log successful creation
    await logSystemTransaction('OPERATOR_CREATED', `${updatedBy} created new operator: ${username} (${role}) in ${department}`, updatedBy);

    res.json({
      success: true,
      message: "Operator added successfully",
    })
  } catch (error) {
    console.error("Add operator error:", error)
    await logSystemTransaction('OPERATOR_CREATE_ERROR', `Error creating operator ${username}: ${error.message}`, updatedBy);
    res.status(500).json({
      success: false,
      message: "Failed to add operator",
    })
  }
})

// Update operator with department restrictions
app.put("/operators/:id", async (req, res) => {
  const { id } = req.params
  const { username, password, department, user_role, user_department } = req.body
  const updatedBy = req.headers["user-name"] || 'unknown'

  // Check if user has permission
  if (user_role !== "admin" && user_role !== "supervisor") {
    await logSystemTransaction('ACCESS_DENIED', `${updatedBy} attempted to update operator without permission`, updatedBy);
    return res.status(403).json({
      success: false,
      message: "Insufficient permissions. Only admin and supervisor can update operators.",
    })
  }

  try {
    // Check if operator exists and get current info
    const [existing] = await pool.execute("SELECT username, role, department FROM operators WHERE id = ?", [id])

    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Operator not found",
      })
    }

    const oldOperator = existing[0];

    // Supervisors can only update operators in their department
    if (user_role === "supervisor") {
      if (existing[0].role !== "operator") {
        await logSystemTransaction('ACCESS_DENIED', `${updatedBy} (supervisor) attempted to update non-operator account: ${oldOperator.username}`, updatedBy);
        return res.status(403).json({
          success: false,
          message: "Supervisors can only update operator accounts.",
        })
      }
      if (existing[0].department !== user_department) {
        await logSystemTransaction('ACCESS_DENIED', `${updatedBy} (supervisor) attempted to update operator in different department`, updatedBy);
        return res.status(403).json({
          success: false,
          message: "Supervisors can only update operators in their own department.",
        })
      }
    }

    // Check if new username already exists (if username is being changed)
    const [duplicateCheck] = await pool.execute("SELECT * FROM operators WHERE username = ? AND id != ?", [
      username,
      id,
    ])

    if (duplicateCheck.length > 0) {
      await logSystemTransaction('OPERATOR_UPDATE_FAILED', `${updatedBy} attempted to update operator with duplicate username: ${username}`, updatedBy);
      return res.status(400).json({
        success: false,
        message: "Username already exists",
      })
    }

    // Update operator
    let query = "UPDATE operators SET username = ?"
    const params = [username]
    let changes = [`username: ${oldOperator.username} → ${username}`];

    if (password) {
      query += ", password = ?"
      params.push(password)
      changes.push('password updated');
    }

    // Only admin can change department
    if (user_role === "admin" && department && department !== oldOperator.department) {
      query += ", department = ?"
      params.push(department)
      changes.push(`department: ${oldOperator.department} → ${department}`);
    }

    query += " WHERE id = ?"
    params.push(id)

    await pool.execute(query, params)

    // Log successful update
    await logSystemTransaction('OPERATOR_UPDATED', `${updatedBy} updated operator ${oldOperator.username}: ${changes.join(', ')}`, updatedBy);

    res.json({
      success: true,
     message: "Operator updated successfully",
    })
  } catch (error) {
    console.error("Update operator error:", error)
    await logSystemTransaction('OPERATOR_UPDATE_ERROR', `Error updating operator: ${error.message}`, updatedBy);
    res.status(500).json({
      success: false,
      message: "Failed to update operator",
    })
  }
})

// Delete operator with department restrictions
app.delete("/operators/:id", async (req, res) => {
  const { id } = req.params
  const { user_role, user_department } = req.body
  const updatedBy = req.headers["user-name"] || 'unknown'

  // Check if user has permission
  if (user_role !== "admin" && user_role !== "supervisor") {
    await logSystemTransaction('ACCESS_DENIED', `${updatedBy} attempted to delete operator without permission`, updatedBy);
    return res.status(403).json({
      success: false,
      message: "Insufficient permissions. Only admin and supervisor can delete operators.",
    })
  }

  try {
    // Check if operator exists and get current info
    const [existing] = await pool.execute("SELECT username, role, department FROM operators WHERE id = ?", [id])

    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Operator not found",
      })
    }

    const operatorToDelete = existing[0];

    // Supervisors can only delete operators in their department
    if (user_role === "supervisor") {
      if (existing[0].role !== "operator") {
        await logSystemTransaction('ACCESS_DENIED', `${updatedBy} (supervisor) attempted to delete non-operator account: ${operatorToDelete.username}`, updatedBy);
        return res.status(403).json({
          success: false,
          message: "Supervisors can only delete operator accounts.",
        })
      }
      if (existing[0].department !== user_department) {
        await logSystemTransaction('ACCESS_DENIED', `${updatedBy} (supervisor) attempted to delete operator in different department`, updatedBy);
        return res.status(403).json({
          success: false,
          message: "Supervisors can only delete operators in their own department.",
        })
      }
    }

    await pool.execute("DELETE FROM operators WHERE id = ?", [id])

    // Log successful deletion
    await logSystemTransaction('OPERATOR_DELETED', `${updatedBy} deleted operator: ${operatorToDelete.username} (${operatorToDelete.role}) from ${operatorToDelete.department}`, updatedBy);

    res.json({
      success: true,
      message: "Operator deleted successfully",
    })
  } catch (error) {
    console.error("Delete operator error:", error)
    await logSystemTransaction('OPERATOR_DELETE_ERROR', `Error deleting operator: ${error.message}`, updatedBy);
    res.status(500).json({
      success: false,
      message: "Failed to delete operator",
    })
  }
})

// Get stock with department filtering and alerts - FIXED FOR PUBLIC ACCESS
app.get("/stock/alerts", async (req, res) => {
  const userRole = req.headers["user-role"]
  const userDepartment = req.headers["user-department"]
  const username = req.headers["user-name"] || 'anonymous'

  console.log("=== STOCK ALERTS REQUEST DEBUG ===")
  console.log("Headers received:")
  console.log("  user-role:", userRole)
  console.log("  user-department:", userDepartment)

  try {
    let query = `
      SELECT *, 
             CASE 
                 WHEN quantity <= threshold_value THEN 'LOW_STOCK'
                 ELSE 'NORMAL'
             END as alert_status
      FROM stock 
    `
    const params = []

    // Handle different access levels
    if (!userRole || userRole === "undefined") {
      // Public access (HomePage) - show all items
      console.log("🌐 Public access - showing all departments")
    } else if (userRole === "supervisor" || userRole === "operator") {
      // Authenticated supervisor/operator access - filter by department
      if (!userDepartment || userDepartment === "undefined" || userDepartment === "null") {
        console.log("❌ Missing or invalid department for supervisor/operator")
        return res.status(400).json({
          success: false,
          message:
            "Valid department is required for supervisor/operator access. Please ensure your account has a department assigned.",
        })
      }

      query += " WHERE department = ?"
      params.push(userDepartment)
      console.log("🔒 Applying department filter for:", userRole)
      console.log("🏭 Filtering by department:", userDepartment)
    } else if (userRole === "admin") {
      // Admin access - show all departments
      console.log("👑 Admin access - showing all departments")
    } else {
      console.log("❌ Invalid user role:", userRole)
      return res.status(403).json({
        success: false,
        message: "Invalid user role",
      })
    }

    query += ` ORDER BY 
      department,
      CASE WHEN quantity <= threshold_value THEN 1 ELSE 2 END,
      item_name ASC
    `

    console.log("🔍 Final SQL Query:", query)
    console.log("🔍 Query Parameters:", params)

    const [rows] = await pool.execute(query, params)

    console.log("📊 Raw query results:", rows.length, "items found")

    if (rows.length > 0) {
      const departments = [...new Set(rows.map((item) => item.department))]
      console.log("🏭 Departments in results:", departments)
      console.log("📦 Items found:")
      rows.forEach((item, index) => {
        console.log(`  ${index + 1}. ${item.item_name} (${item.department}) - Qty: ${item.quantity}`)
      })
    } else {
      console.log("⚠️ No items found")
    }

    // Get low stock items with names
    const lowStockItems = rows.filter((item) => item.quantity <= item.threshold_value)
    const lowStockNames = lowStockItems.map((item) => item.item_name)

    console.log("⚠️ Low stock items count:", lowStockItems.length)
    if (lowStockNames.length > 0) {
      console.log("⚠️ Low stock items:", lowStockNames)
    }
    console.log("=== END STOCK ALERTS REQUEST DEBUG ===")

    // Log access
    await logSystemTransaction('STOCK_ACCESSED', `${username} (${userRole || 'public'}) accessed stock alerts - ${rows.length} items, ${lowStockItems.length} low stock`, username);

    res.json({
      success: true,
      data: rows,
      lowStockCount: lowStockItems.length,
      lowStockItems: lowStockNames,
    })
  } catch (error) {
    console.error("❌ Fetch stock alerts error:", error)
    await logSystemTransaction('STOCK_ACCESS_ERROR', `Error accessing stock alerts: ${error.message}`, username);
    res.status(500).json({
      success: false,
      message: "Failed to fetch stock data: " + error.message,
    })
  }
})

// Get all stock with department filtering
app.get("/stock", async (req, res) => {
  const userRole = req.headers["user-role"]
  const userDepartment = req.headers["user-department"]
  const username = req.headers["user-name"] || 'anonymous'

  try {
    let query = `
      SELECT *, 
             CASE 
                 WHEN quantity <= threshold_value THEN 'LOW_STOCK'
                 ELSE 'NORMAL'
             END as alert_status
      FROM stock 
    `
    const params = []

    // Apply department filtering based on role
    if (userRole === "supervisor" || userRole === "operator") {
      if (!userDepartment) {
        return res.status(400).json({
          success: false,
          message: "Department is required for supervisor/operator access",
        })
      }
      query += " WHERE department = ?"
      params.push(userDepartment)
    }

    query += " ORDER BY department, item_name ASC"

    console.log("Stock query:", query)
    console.log("Stock params:", params)

    const [rows] = await pool.execute(query, params)

    // Log access
    await logSystemTransaction('STOCK_VIEWED', `${username} (${userRole || 'public'}) viewed stock list - ${rows.length} items`, username);

    res.json({
      success: true,
      data: rows,
    })
  } catch (error) {
    console.error("Fetch stock error:", error)
    await logSystemTransaction('STOCK_VIEW_ERROR', `Error viewing stock: ${error.message}`, username);
    res.status(500).json({
      success: false,
      message: "Failed to fetch stock data",
    })
  }
})

// Add new stock item with department and price
app.post("/stock", async (req, res) => {
  const { item_name, quantity, threshold_value = 10,  department, updated_by, user_role, user_department } = req.body

  // Check if user has permission
  if (user_role !== "admin" && user_role !== "supervisor") {
    await logSystemTransaction('ACCESS_DENIED', `${updated_by} attempted to add stock item without permission`, updated_by);
    return res.status(403).json({
      success: false,
      message: "Insufficient permissions. Only admin and supervisor can add new items.",
    })
  }

  // Supervisors can only add items to their department
  if (user_role === "supervisor" && department !== user_department) {
    await logSystemTransaction('ACCESS_DENIED', `${updated_by} (supervisor) attempted to add item to different department`, updated_by);
    return res.status(403).json({
      success: false,
      message: "Supervisors can only add items to their own department.",
    })
  }

  // Validate department
  const validDepartments = ["Moulding", "Melting", "Grinding", "Inspection"]
  if (!validDepartments.includes(department)) {
    return res.status(400).json({
      success: false,
      message: "Invalid department. Must be one of: " + validDepartments.join(", "),
    })
  }

  const updatedByStr = `${updated_by} (${user_role})`

  try {
    // Check if item already exists in the same department
    const [existing] = await pool.execute("SELECT * FROM stock WHERE item_name = ? AND department = ?", [
      item_name,
      department,
    ])

    if (existing.length > 0) {
      // Update existing item
      const [old] = await pool.execute("SELECT id, quantity FROM stock WHERE item_name = ? AND department = ?", [item_name, department]);
      const oldQty = old[0].quantity;
      
      const stockId = old[0].id;

      await pool.execute(
        "UPDATE stock SET quantity = ?, updated_by = ?, last_updated = CURRENT_TIMESTAMP WHERE item_name = ? AND department = ?",
        [quantity, updatedByStr, item_name, department],
      )

      if (quantity !== oldQty) {
        const delta = quantity - oldQty;
        const type = delta > 0 ? 'IN' : 'OUT';
        const absDelta = Math.abs(delta);
        
        await logStockTransaction(stockId, type, absDelta, 0.00, updatedByStr, `Stock quantity updated from ${oldQty} to ${quantity}`);
      }

      // Log the update
      await logSystemTransaction('STOCK_UPDATED', `${updated_by} updated existing item: ${item_name} in ${department} (Qty: ${oldQty} → ${quantity})`, updated_by);

      res.json({
        success: true,
        message: "Stock updated successfully",
      })
    } else {
      // Insert new item
      await pool.execute(
        "INSERT INTO stock (item_name, quantity, threshold_value, department, updated_by) VALUES (?, ?, ?, ?, ?)",
        [item_name, quantity, threshold_value, department, updatedByStr],
      )

      const [insertRes] = await pool.execute("SELECT LAST_INSERT_ID() as id");
      const newId = insertRes[0].id;

      if (quantity > 0) {
        await logStockTransaction(newId, 'IN', quantity, 0.00, updatedByStr, `New item added to inventory`);
      }

      // Log the creation
      await logSystemTransaction('STOCK_CREATED', `${updated_by} created new item: ${item_name} in ${department} (Qty: ${quantity})`, updated_by);

      res.json({
        success: true,
        message: "Stock added successfully",
      })
    }
  } catch (error) {
    console.error("Add stock error:", error)
    await logSystemTransaction('STOCK_ADD_ERROR', `Error adding stock item ${item_name}: ${error.message}`, updated_by);
    res.status(500).json({
      success: false,
      message: "Failed to add stock",
    })
  }
})

// Update stock quantity with department restrictions
app.put("/stock/:id", async (req, res) => {
  const { id } = req.params
  const { quantity, threshold_value, updated_by, user_role, user_department } = req.body

  console.log("=== STOCK UPDATE REQUEST ===")
  console.log("Stock ID:", id)
  console.log("User Role:", user_role)
  console.log("User Department:", user_department)

  const updatedByStr = `${updated_by} (${user_role})`

  try {
    // Check if stock exists and get department
    const [existing] = await pool.execute("SELECT department, item_name, quantity, threshold_value FROM stock WHERE id = ?", [id])

    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Stock item not found",
      })
    }

    const currentStock = existing[0];
    console.log("📦 Stock item:", currentStock.item_name, "Department:", currentStock.department)

    // Check department access
    if ((user_role === "supervisor" || user_role === "operator") && currentStock.department !== user_department) {
      console.log("❌ Department access denied")
      await logSystemTransaction('ACCESS_DENIED', `${updated_by} attempted to update item in different department: ${currentStock.item_name}`, updated_by);
      return res.status(403).json({
        success: false,
        message: "You can only update items in your department.",
      })
    }

    // If threshold_value is provided, check permissions
    if (threshold_value !== undefined && user_role !== "admin" && user_role !== "supervisor") {
      await logSystemTransaction('ACCESS_DENIED', `${updated_by} attempted to update threshold without permission for ${currentStock.item_name}`, updated_by);
      return res.status(403).json({
        success: false,
        message: "Insufficient permissions. Only admin and supervisor can update thresholds.",
      })
    }

    // Build update query based on what's being updated
    let query = "UPDATE stock SET "
    const params = []
    let changes = [];

    let oldQty = currentStock.quantity;
    let oldThreshold = currentStock.threshold_value;

    if (quantity !== undefined && quantity !== oldQty) {
      query += "quantity = ?, "
      params.push(quantity)
      changes.push(`quantity: ${oldQty} → ${quantity}`);
    }

    if (threshold_value !== undefined && threshold_value !== oldThreshold) {
      query += "threshold_value = ?, "
      params.push(threshold_value)
      changes.push(`threshold: ${oldThreshold} → ${threshold_value}`);
    }

    query += "updated_by = ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?"
    params.push(updatedByStr, id)

    console.log("🔍 Update query:", query)
    console.log("🔍 Update params:", params)

    await pool.execute(query, params)

    // Log quantity change transaction
    if (quantity !== undefined && quantity !== oldQty) {
      const delta = quantity - oldQty;
      const type = delta > 0 ? 'IN' : 'OUT';
      const absDelta = Math.abs(delta);
     
      await logStockTransaction(id, type, absDelta, 0.00, updatedByStr, `Manual quantity update: ${oldQty} → ${quantity}`);
    }

    // Log the update
    if (changes.length > 0) {
      await logSystemTransaction('STOCK_UPDATED', `${updated_by} updated ${currentStock.item_name}: ${changes.join(', ')}`, updated_by);
    }

    console.log("✅ Stock updated successfully")
    console.log("=== END STOCK UPDATE REQUEST ===")
    await notifyLowStock()
    res.json({
      success: true,
      message: "Stock updated successfully",
    })
  } catch (error) {
    console.error("❌ Stock update error:", error)
    await logSystemTransaction('STOCK_UPDATE_ERROR', `Error updating stock item: ${error.message}`, updated_by);
    res.status(500).json({
      success: false,
      message: "Failed to update stock",
    })
  }
})

// Update stock threshold with department restrictions
app.put("/stock/:id/threshold", async (req, res) => {
  const { id } = req.params
  const { threshold_value, updated_by, user_role, user_department } = req.body

  // Check if user has permission
  if (user_role !== "admin" && user_role !== "supervisor") {
    await logSystemTransaction('ACCESS_DENIED', `${updated_by} attempted to update threshold without permission`, updated_by);
    return res.status(403).json({
      success: false,
      message: "Insufficient permissions. Only admin and supervisor can update thresholds.",
    })
  }

  try {
    // Check if stock exists and get department
    const [existing] = await pool.execute("SELECT department, item_name, threshold_value FROM stock WHERE id = ?", [id])

    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Stock item not found",
      })
    }

    const currentStock = existing[0];

    // Check department access for supervisors
    if (user_role === "supervisor" && currentStock.department !== user_department) {
      await logSystemTransaction('ACCESS_DENIED', `${updated_by} (supervisor) attempted to update threshold for item in different department: ${currentStock.item_name}`, updated_by);
      return res.status(403).json({
        success: false,
        message: "You can only update thresholds for items in your department.",
      })
    }

    await pool.execute(
      "UPDATE stock SET threshold_value = ?, updated_by = ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?",
      [threshold_value, `${updated_by} (${user_role})`, id],
    )

    // Log the threshold update
    await logSystemTransaction('THRESHOLD_UPDATED', `${updated_by} updated threshold for ${currentStock.item_name}: ${currentStock.threshold_value} → ${threshold_value}`, updated_by);

    res.json({
      success: true,
      message: "Stock threshold updated successfully",
    })
  } catch (error) {
    console.error("Threshold update error:", error)
    await logSystemTransaction('THRESHOLD_UPDATE_ERROR', `Error updating threshold: ${error.message}`, updated_by);
    res.status(500).json({
      success: false,
      message: "Failed to update stock threshold",
    })
  }
})

// Delete stock item (admin only)
app.delete("/stock/:id", async (req, res) => {
  const { id } = req.params
  const { user_role } = req.body
  const updatedBy = req.headers["user-name"] || 'unknown'

  // Check if user has permission
  if (user_role !== "admin") {
    await logSystemTransaction('ACCESS_DENIED', `${updatedBy} attempted to delete stock item without admin permission`, updatedBy);
    return res.status(403).json({
      success: false,
      message: "Insufficient permissions. Only admin can delete items.",
    })
  }

  try {
    // Get item details before deletion
    const [existing] = await pool.execute("SELECT item_name, department, quantity FROM stock WHERE id = ?", [id])

    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Stock item not found",
      })
    }

    const stockToDelete = existing[0];

    // Log the deletion transaction if there was quantity
    if (stockToDelete.quantity > 0) {
      await logStockTransaction(id, 'OUT', stockToDelete.quantity, 0.00, `${updatedBy} (${user_role})`, `Item deleted from inventory`);
    }

    await pool.execute("DELETE FROM stock WHERE id = ?", [id])

    // Log the deletion
    await logSystemTransaction('STOCK_DELETED', `${updatedBy} deleted item: ${stockToDelete.item_name} from ${stockToDelete.department} (had ${stockToDelete.quantity} units)`, updatedBy);

    res.json({
      success: true,
      message: "Stock item deleted successfully",
    })
  } catch (error) {
    console.error("Delete stock error:", error)
    await logSystemTransaction('STOCK_DELETE_ERROR', `Error deleting stock item: ${error.message}`, updatedBy);
    res.status(500).json({
      success: false,
      message: "Failed to delete stock item",
    })
  }
})

// Get individual stock item (for chatbot)
app.get("/get-stock/:item", async (req, res) => {
  const { item } = req.params;
  const username = req.headers["user-name"] || 'chatbot_user';

  try {
    const [rows] = await pool.execute("SELECT item_name, quantity FROM stock WHERE LOWER(item_name) LIKE ?", [`%${item}%`]);

    // Log the chatbot query
    await logSystemTransaction('CHATBOT_QUERY', `${username} queried stock via chatbot for: ${item}`, username);

    if (rows.length === 0) {
      return res.json({message: "Item not found in inventory."});
    }

    if (rows.length > 1) {
      const list = rows.map(r => `${r.item_name}: ${r.quantity} units`).join('\n');
      return res.json({message: `Multiple items found:\n${list}`});
    }

    const stock = rows[0];
    return res.json({message: `${stock.item_name}: ${stock.quantity} units available.`});
  } catch (error) {
    console.error(error);
    await logSystemTransaction('CHATBOT_ERROR', `Chatbot query error for ${item}: ${error.message}`, username);
    res.status(500).json({message: "Error checking stock."});
  }
});

// Get reports data with department breakdown - ADD THIS TO YOUR NEW SERVER.JS
app.get("/reports", async (req, res) => {
  const userRole = req.headers["user-role"]
  const userDepartment = req.headers["user-department"]
  const username = req.headers["user-name"] || 'unknown'

  // Check if user has permission
  if (userRole !== "admin" && userRole !== "supervisor") {
    await logSystemTransaction('ACCESS_DENIED', `${username} attempted to access reports without permission`, username);
    return res.status(403).json({
      success: false,
      message: "Insufficient permissions. Only admin and supervisor can access reports.",
    })
  }

  try {
    let stockQuery = `
      SELECT 
          department,
          COUNT(*) as total_products,
          SUM(quantity) as total_stock,
          COUNT(CASE WHEN quantity <= threshold_value THEN 1 END) as low_stock_count,
          AVG(quantity) as avg_stock_per_product
      FROM stock
    `
    let operatorsQuery = `
      SELECT 
          department,
          COUNT(*) as total_operators,
          COUNT(CASE WHEN role = 'operator' THEN 1 END) as operators_count,
          COUNT(CASE WHEN role = 'supervisor' THEN 1 END) as supervisors_count
      FROM operators
      WHERE department IS NOT NULL
    `
    let recentUpdatesQuery = `
      SELECT item_name, quantity, department, updated_by, last_updated
      FROM stock 
    `
    let lowStockQuery = `
      SELECT item_name, quantity, threshold_value, department
      FROM stock 
      WHERE quantity <= threshold_value
    `

    let params = []

    // Apply department filtering for supervisors
    if (userRole === "supervisor") {
      stockQuery += " WHERE department = ?"
      operatorsQuery += " AND department = ?"
      recentUpdatesQuery += " WHERE department = ?"
      lowStockQuery += " AND department = ?"
      params = [userDepartment, userDepartment, userDepartment, userDepartment]
    }

    stockQuery += " GROUP BY department ORDER BY department"
    operatorsQuery += " GROUP BY department ORDER BY department"
    recentUpdatesQuery += " ORDER BY last_updated DESC LIMIT 10"
    lowStockQuery += " ORDER BY department, quantity ASC"

    // Execute queries
    const [stockSummary] = await pool.execute(stockQuery, userRole === "supervisor" ? [userDepartment] : [])
    const [operatorsSummary] = await pool.execute(operatorsQuery, userRole === "supervisor" ? [userDepartment] : [])
    const [recentUpdates] = await pool.execute(recentUpdatesQuery, userRole === "supervisor" ? [userDepartment] : [])
    const [lowStockItems] = await pool.execute(lowStockQuery, userRole === "supervisor" ? [userDepartment] : [])

    // Calculate totals for admin
    let totalStockSummary = null
    let totalOperatorsSummary = null

    if (userRole === "admin") {
      totalStockSummary = stockSummary.reduce(
        (acc, dept) => ({
          total_products: acc.total_products + Number.parseInt(dept.total_products),
          total_stock: acc.total_stock + Number.parseInt(dept.total_stock),
          low_stock_count: acc.low_stock_count + Number.parseInt(dept.low_stock_count),
          avg_stock_per_product:
            stockSummary.reduce((sum, d) => sum + Number.parseFloat(d.avg_stock_per_product), 0) / stockSummary.length,
        }),
        { total_products: 0, total_stock: 0, low_stock_count: 0, avg_stock_per_product: 0 },
      )

      totalOperatorsSummary = operatorsSummary.reduce(
        (acc, dept) => ({
          total_operators: acc.total_operators + Number.parseInt(dept.total_operators),
          operators_count: acc.operators_count + Number.parseInt(dept.operators_count),
          supervisors_count: acc.supervisors_count + Number.parseInt(dept.supervisors_count),
          admins_count: 1, // Assuming 1 admin
        }),
        { total_operators: 0, operators_count: 0, supervisors_count: 0, admins_count: 0 },
      )
    }

    // Log reports access
    await logSystemTransaction('REPORTS_ACCESSED', `${username} (${userRole}) accessed main reports dashboard`, username);

    res.json({
      success: true,
      data: {
        stockSummary: userRole === "admin" ? totalStockSummary : stockSummary[0],
        stockByDepartment: stockSummary,
        operatorsSummary: userRole === "admin" ? totalOperatorsSummary : operatorsSummary[0],
        operatorsByDepartment: operatorsSummary,
        recentUpdates,
        lowStockItems,
      },
    })
  } catch (error) {
    console.error("Fetch reports error:", error)
    await logSystemTransaction('REPORTS_ERROR', `Error fetching reports: ${error.message}`, username);
    res.status(500).json({
      success: false,
      message: "Failed to fetch reports data",
    })
  }
})

// Daily report endpoint - FOCUSES ON QUANTITIES NOT VALUES
app.get('/reports/daily/:date', async (req, res) => {
  const { date } = req.params;
  const username = req.headers["user-name"] || 'unknown';

  try {
    const [trans] = await pool.execute(
      `SELECT t.*, s.item_name, DATE_FORMAT(t.transaction_date, '%H:%i:%s') as time
       FROM transactions t LEFT JOIN stock s ON t.stock_id = s.id
       WHERE DATE(t.transaction_date) = ? ORDER BY t.transaction_date DESC`,
      [date]
    );

    // Log report access
    await logSystemTransaction('REPORT_ACCESSED', `${username} accessed daily report for ${date} - ${trans.length} transactions`, username);

    if (trans.length === 0) {
      return res.json({ success: false, message: 'No transactions found for this date' });
    }

    let totalTransactions = trans.length; 
    let itemsAdded = 0;
    let itemsRemoved = 0;
    let totalProductAdded = 0;
    let totalProductRemoved = 0;

    trans.forEach(t => {
      if (t.type === 'IN') {
        itemsAdded += 1;
      } else if (t.type === 'OUT') {
        itemsRemoved += 1;
      }

      if (t.type === 'IN') {
        totalProductAdded += t.quantity;
      } else if (t.type === 'OUT') {
        totalProductRemoved += t.quantity;
      }


    });


    res.json({
      success: true,
      data: {
        totalTransactions,
        itemsAdded,
        itemsRemoved,
        totalProductAdded,
        totalProductRemoved,
        transactions: trans.map(t => ({
          item_name: t.item_name || 'System Operation',
          type: t.type,
          quantity: t.quantity,
          time: t.time,
          notes: t.notes,
          updated_by: t.updated_by
        }))
      }
    });
  } catch (error) {
    console.error('Daily report error:', error);
    await logSystemTransaction('REPORT_ERROR', `Error generating daily report for ${date}: ${error.message}`, username);
    res.json({ success: false, message: 'Error generating report' });
  }
});

// Monthly report endpoint - FOCUSES ON QUANTITIES NOT VALUES
app.get('/reports/monthly/:month', async (req, res) => {
  const { month } = req.params; // YYYY-MM
  const [year, mon] = month.split('-');
  const username = req.headers["user-name"] || 'unknown';

  try {
    const [trans] = await pool.execute(
      `SELECT t.*, s.item_name, s.department, DATE(t.transaction_date) as transaction_day
       FROM transactions t LEFT JOIN stock s ON t.stock_id = s.id
       WHERE YEAR(t.transaction_date) = ? AND MONTH(t.transaction_date) = ?
       ORDER BY t.transaction_date DESC`,
      [year, mon]
    );

    // Log report access
    await logSystemTransaction('REPORT_ACCESSED', `${username} accessed monthly report for ${month} - ${trans.length} transactions`, username);

    if (trans.length === 0) {
      return res.json({ success: false, message: 'No transactions found for this month' });
    }

    let totalTransactions = trans.length;
    let itemsAdded = 0;
    let itemsRemoved = 0;
    let departmentStats = {};
    let dailyStats = {};
    let itemActivityMap = new Map();

    trans.forEach(t => {
      // Department statistics
      const dept = t.department || 'System Operations';
      if (!departmentStats[dept]) {
        departmentStats[dept] = { transactions: 0, itemsAdded: 0, itemsRemoved: 0 };
      }
      departmentStats[dept].transactions++;

      // Daily statistics
      const day = t.transaction_day;
      if (!dailyStats[day]) {
        dailyStats[day] = { transactions: 0, itemsAdded: 0, itemsRemoved: 0 };
      }
      dailyStats[day].transactions++;

      // Item activity tracking
      if (t.stock_id && t.item_name) {
        if (!itemActivityMap.has(t.stock_id)) {
          itemActivityMap.set(t.stock_id, { 
            item_name: t.item_name, 
            department: t.department,
            transactions: 0, 
            totalIn: 0, 
            totalOut: 0 
          });
        }
        const itemStats = itemActivityMap.get(t.stock_id);
        itemStats.transactions++;
        
        if (t.type === 'IN') {
          itemStats.totalIn += t.quantity;
        } else if (t.type === 'OUT') {
          itemStats.totalOut += t.quantity;
        }
      }

      // Overall totals
      if (t.type === 'IN') {
        itemsAdded += t.quantity;
        departmentStats[dept].itemsAdded += t.quantity;
        dailyStats[day].itemsAdded += t.quantity;
      } else if (t.type === 'OUT') {
        itemsRemoved += t.quantity;
        departmentStats[dept].itemsRemoved += t.quantity;
        dailyStats[day].itemsRemoved += t.quantity;
      }
    });

    // Convert item activity map to sorted array
    const topActiveItems = Array.from(itemActivityMap.values())
      .sort((a, b) => b.transactions - a.transactions)
      .slice(0, 10); // Top 10 most active items

    res.json({
      success: true,
      data: {
        summary: {
          totalTransactions,
          itemsAdded,
          itemsRemoved,
          netChange: itemsAdded - itemsRemoved
        },
        departmentBreakdown: departmentStats,
        dailyActivity: dailyStats,
        topActiveItems,
        period: {
          month: parseInt(mon),
          year: parseInt(year),
          monthName: new Date(year, mon - 1).toLocaleString('default', { month: 'long' })
        }
      }
    });
  } catch (error) {
    console.error('Monthly report error:', error);
    await logSystemTransaction('REPORT_ERROR', `Error generating monthly report for ${month}: ${error.message}`, username);
    res.json({ success: false, message: 'Error generating report' });
  }
});

// Low stock requests for admin
// Get all low stock requests with detailed information
app.get("/low-stock-requests", async (req, res) => {
  const userRole = req.headers["user-role"]
  const userDepartment = req.headers["user-department"]
  const username = req.headers["user-name"] || 'unknown'

  try {
    let query = `SELECT lsr.id, lsr.stock_id, s.item_name, s.department, s.quantity, s.threshold_value, requester.username as requested_by_name, lsr.request_date, lsr.status, approver.username as approved_by_name, lsr.approval_date FROM warehouse_stock.low_stock_requests lsr JOIN warehouse_stock.stock s ON lsr.stock_id = s.id JOIN warehouse_stock.operators requester ON lsr.requested_by = requester.id LEFT JOIN warehouse_stock.operators approver ON lsr.approved_by = approver.id`
    const params = []

    // Apply department filter for non-admins
    if (userRole !== "admin") {
      query += " WHERE s.department = ?"
      params.push(userDepartment)
    }

    query += " ORDER BY lsr.status = 'PENDING' DESC, lsr.request_date DESC"

    const [requests] = await pool.execute(query, params)

    // Log access
    await logSystemTransaction('REQUESTS_ACCESSED', `${username} (${userRole}) accessed low stock requests - ${requests.length} requests`, username);

    res.json({
      success: true,
      data: requests,
    })
  } catch (error) {
    console.error("Error fetching low stock requests:", error)
    await logSystemTransaction('REQUESTS_ACCESS_ERROR', `Error fetching requests: ${error.message}`, username);
    res.status(500).json({
      success: false,
      message: "Failed to fetch low stock requests",
    })
  }
})

// Create a new low stock request
app.post("/low-stock-requests", async (req, res) => {
  const { stock_id, requested_by, user_role, user_department } = req.body
  const username = req.headers["user-name"] || 'unknown'

  try {
    // Verify stock item exists and is actually low
    const [stockItem] = await pool.execute(
      `SELECT s.id, s.item_name, s.department, s.quantity, s.threshold_value FROM warehouse_stock.stock s WHERE s.id = ?`,
      [stock_id],
    )

    if (stockItem.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Stock item not found",
      })
    }

    const item = stockItem[0];

    // Verify stock is actually low
    if (item.quantity > item.threshold_value) {
      await logSystemTransaction('REQUEST_REJECTED', `${username} attempted to create request for non-low stock item: ${item.item_name}`, username);
      return res.status(400).json({
        success: false,
        message: "This item is not currently low in stock",
      })
    }

    // Verify user has access to this department
    if (user_role !== "admin" && item.department !== user_department) {
      await logSystemTransaction('ACCESS_DENIED', `${username} attempted to create request for item in different department: ${item.item_name}`, username);
      return res.status(403).json({
        success: false,
        message: "You can only request items from your department",
      })
    }

    // Check for existing pending request
    const [existing] = await pool.execute(
      `SELECT id FROM warehouse_stock.low_stock_requests WHERE stock_id = ? AND status = 'PENDING'`,
      [stock_id],
    )

    if (existing.length > 0) {
      await logSystemTransaction('REQUEST_DUPLICATE', `${username} attempted to create duplicate request for: ${item.item_name}`, username);
      return res.status(400).json({
        success: false,
        message: "There is already a pending request for this item",
      })
    }

    // Create new request
    await pool.execute(
      `INSERT INTO warehouse_stock.low_stock_requests (stock_id, requested_by, status) VALUES (?, ?, 'PENDING')`,
      [stock_id, requested_by],
    )

    // Log the request creation
    await logSystemTransaction('REQUEST_CREATED', `${username} created low stock request for ${item.item_name} in ${item.department}`, username);

    res.json({
      success: true,
      message: "Low stock request created successfully",
    })
  } catch (error) {
    console.error("Error creating low stock request:", error)
    await logSystemTransaction('REQUEST_CREATE_ERROR', `Error creating request: ${error.message}`, username);
    res.status(500).json({
      success: false,
      message: "Failed to create low stock request",
    })
  }
})

/*app.put("/low-stock-requests/:id/approve", async (req, res) => {
  const { id } = req.params
  const { approved_by, user_role, user_department } = req.body
  const username = req.headers["user-name"] || 'unknown'

  try {
    // Get request with stock and vendor details
    const [request] = await pool.execute(
      `SELECT lsr.*, s.department, s.item_name, s.quantity, s.threshold_value, v.email as vendor_email, v.name as vendor_name FROM warehouse_stock.low_stock_requests lsr JOIN warehouse_stock.stock s ON lsr.stock_id = s.id LEFT JOIN warehouse_stock.vendors v ON s.vendor_id = v.id WHERE lsr.id = ?`,
      [id],
    )

    if (request.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Request not found",
      })
    }

    const req_data = request[0];

    // Verify permissions
    if (user_role !== "admin" && req_data.department !== user_department) {
      await logSystemTransaction('ACCESS_DENIED', `${username} attempted to approve request for different department: ${req_data.item_name}`, username);
      return res.status(403).json({
        success: false,
        message: "You can only approve requests from your department",
      })
    }

    // Verify request is pending
    if (req_data.status !== "PENDING") {
      await logSystemTransaction('REQUEST_INVALID_STATUS', `${username} attempted to approve non-pending request for: ${req_data.item_name}`, username);
      return res.status(400).json({
        success: false,
        message: "Only pending requests can be approved",
      })
    }

    // Update request status
    await pool.execute(
      `UPDATE warehouse_stock.low_stock_requests SET status = 'APPROVED', approved_by = ?, approval_date = CURRENT_TIMESTAMP WHERE id = ?`,
      [approved_by, id],
    )

    // Log the approval
    await logSystemTransaction('REQUEST_APPROVED', `${username} approved low stock request for ${req_data.item_name} in ${req_data.department}`, username);

    // If vendor email exists, log vendor notification attempt
    if (req_data.vendor_email) {
      await logSystemTransaction('VENDOR_NOTIFY', `Vendor notification attempted for ${req_data.vendor_name} (${req_data.vendor_email}) regarding ${req_data.item_name}`, username);
    }

    res.json({
      success: true,
      message: "Request approved successfully",
    })
  } catch (error) {
    console.error("Error approving request:", error)
    await logSystemTransaction('REQUEST_APPROVE_ERROR', `Error approving request: ${error.message}`, username);
    res.status(500).json({
      success: false,
      message: "Failed to approve request",
    })
  }
})
*/
app.put("/low-stock-requests/:id/approve", async (req, res) => {
  const { id } = req.params;
  const { approved_by, user_role, user_department } = req.body;
  const username = req.headers["user-name"] || 'unknown';

  try {
    const [request] = await pool.execute(
      `SELECT lsr.*, s.department, s.item_name, s.quantity, s.threshold_value, 
              v.email as vendor_email, v.name as vendor_name 
       FROM warehouse_stock.low_stock_requests lsr 
       JOIN warehouse_stock.stock s ON lsr.stock_id = s.id 
       LEFT JOIN warehouse_stock.vendors v ON s.vendor_id = v.id 
       WHERE lsr.id = ?`,
      [id],
    );

    if (request.length === 0) return res.status(404).json({ success: false, message: "Request not found" });
    const req_data = request[0];

    if (user_role !== "admin" && req_data.department !== user_department) {
      await logSystemTransaction('ACCESS_DENIED', `${username} attempted to approve request for different department: ${req_data.item_name}`, username);
      return res.status(403).json({ success: false, message: "You can only approve requests from your department" });
    }

    if (req_data.status !== "PENDING") {
      await logSystemTransaction('REQUEST_INVALID_STATUS', `${username} attempted to approve non-pending request for: ${req_data.item_name}`, username);
      return res.status(400).json({ success: false, message: "Only pending requests can be approved" });
    }

    await pool.execute(
      `UPDATE warehouse_stock.low_stock_requests 
       SET status = 'APPROVED', approved_by = ?, approval_date = CURRENT_TIMESTAMP 
       WHERE id = ?`,
      [approved_by, id],
    );

    await logSystemTransaction('REQUEST_APPROVED', `${username} approved low stock request for ${req_data.item_name} in ${req_data.department}`, username);

    // === EMAIL VENDOR ===
    if (req_data.vendor_email) {
      const mailOptions = {
        from: `"Warehouse System" <${process.env.SMTP_USER}>`,
        to: req_data.vendor_email,
        subject: `Low Stock Order Request: ${req_data.item_name}`,
        text: `Dear ${req_data.vendor_name || "Vendor"},\n\nOur stock for "${req_data.item_name}" is low (Quantity: ${req_data.quantity}, Threshold: ${req_data.threshold_value}). Please arrange for a restock as soon as possible.\n\nThank you,\nWarehouse Management`,
      };

      try {
        await transporter.sendMail(mailOptions);
        await logSystemTransaction('VENDOR_EMAIL_SENT', `Email sent to ${req_data.vendor_name} (${req_data.vendor_email}) for ${req_data.item_name}`, username);
      } catch (emailErr) {
        console.error("Email sending error:", emailErr);
        await logSystemTransaction('VENDOR_EMAIL_ERROR', `Failed to send email to ${req_data.vendor_email}: ${emailErr.message}`, username);
      }
    }

    res.json({ success: true, message: "Request approved and vendor notified successfully" });
  } catch (error) {
    console.error("Error approving request:", error);
    await logSystemTransaction('REQUEST_APPROVE_ERROR', `Error approving request: ${error.message}`, username);
    res.status(500).json({ success: false, message: "Failed to approve request" });
  }
});

// Reject a low stock request
app.put("/low-stock-requests/:id/reject", async (req, res) => {
  const { id } = req.params
  const { approved_by, user_role, user_department, reason } = req.body
  const username = req.headers["user-name"] || 'unknown'

  try {
    // Get request with stock details
    const [request] = await pool.execute(
      `SELECT lsr.*, s.department, s.item_name FROM warehouse_stock.low_stock_requests lsr JOIN warehouse_stock.stock s ON lsr.stock_id = s.id WHERE lsr.id = ?`,
      [id],
    )

    if (request.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Request not found",
      })
    }

    const req_data = request[0];

    // Verify permissions
    if (user_role !== "admin" && req_data.department !== user_department) {
      await logSystemTransaction('ACCESS_DENIED', `${username} attempted to reject request for different department: ${req_data.item_name}`, username);
      return res.status(403).json({
        success: false,
        message: "You can only reject requests from your department",
      })
    }

    // Verify request is pending
    if (req_data.status !== "PENDING") {
      await logSystemTransaction('REQUEST_INVALID_STATUS', `${username} attempted to reject non-pending request for: ${req_data.item_name}`, username);
      return res.status(400).json({
        success: false,
        message: "Only pending requests can be rejected",
      })
    }

    // Update request status
    await pool.execute(
      `UPDATE warehouse_stock.low_stock_requests SET status = 'REJECTED', approved_by = ?, approval_date = CURRENT_TIMESTAMP WHERE id = ?`,
      [approved_by, id],
    )

    // Log the rejection with reason
    await logSystemTransaction('REQUEST_REJECTED', `${username} rejected request for ${req_data.item_name} in ${req_data.department}. Reason: ${reason || 'No reason provided'}`, username);

    console.log(`Request rejected for ${req_data.item_name}. Reason: ${reason}`)

    res.json({
      success: true,
      message: "Request rejected successfully",
    })
  } catch (error) {
    console.error("Error rejecting request:", error)
    await logSystemTransaction('REQUEST_REJECT_ERROR', `Error rejecting request: ${error.message}`, username);
    res.status(500).json({
      success: false,
      message: "Failed to reject request",
    })
  }
})

// Get low stock request statistics
app.get("/low-stock-requests/stats", async (req, res) => {
  const userRole = req.headers["user-role"]
  const userDepartment = req.headers["user-department"]
  const username = req.headers["user-name"] || 'unknown'

  try {
    let query = `SELECT lsr.status, COUNT(*) as count, s.department FROM warehouse_stock.low_stock_requests lsr JOIN warehouse_stock.stock s ON lsr.stock_id = s.id`
    const params = []

    if (userRole !== "admin") {
      query += " WHERE s.department = ?"
      params.push(userDepartment)
    }

    query += " GROUP BY lsr.status, s.department"

    const [stats] = await pool.execute(query, params)

    // Log stats access
    await logSystemTransaction('STATS_ACCESSED', `${username} (${userRole}) accessed request statistics`, username);

    res.json({
      success: true,
      data: stats,
    })
  } catch (error) {
    console.error("Error fetching request stats:", error)
    await logSystemTransaction('STATS_ERROR', `Error fetching stats: ${error.message}`, username);
    res.status(500).json({
      success: false,
      message: "Failed to fetch request statistics",
    })
  }
})

// Vendors management endpoints
app.get("/vendors", async (req, res) => {
  const username = req.headers["user-name"] || 'unknown';
  
  try {
    const [vendors] = await pool.execute(
      `SELECT id, name, email, phone, address, contact_person FROM warehouse_stock.vendors ORDER BY name`,
    )

    // Log vendor access
    await logSystemTransaction('VENDORS_ACCESSED', `${username} accessed vendor list - ${vendors.length} vendors`, username);

    res.json({
      success: true,
      data: vendors,
    })
  } catch (error) {
    console.error("Error fetching vendors:", error)
    await logSystemTransaction('VENDORS_ERROR', `Error fetching vendors: ${error.message}`, username);
    res.status(500).json({
      success: false,
      message: "Failed to fetch vendors",
    })
  }
})

app.post("/vendors", async (req, res) => {
  const { name, email, phone, address, contact_person } = req.body
  const username = req.headers["user-name"] || 'unknown';

  try {
    await pool.execute(
      `INSERT INTO warehouse_stock.vendors (name, email, phone, address, contact_person) VALUES (?, ?, ?, ?, ?)`,
      [name, email, phone, address, contact_person],
    )

    // Log vendor creation
    await logSystemTransaction('VENDOR_CREATED', `${username} created new vendor: ${name} (${email})`, username);

    res.json({
      success: true,
      message: "Vendor added successfully",
    })
  } catch (error) {
    console.error("Error adding vendor:", error)
    await logSystemTransaction('VENDOR_CREATE_ERROR', `Error creating vendor ${name}: ${error.message}`, username);
    res.status(500).json({
      success: false,
      message: "Failed to add vendor",
    })
  }
})
// Create a bill (reduce stock quantity)
app.post("/billing", async (req, res) => {
  const { customer_name, customer_phone, items, created_by, user_role, user_department } = req.body;

  const connection = await pool.getConnection();
  await connection.beginTransaction();

  try {
    // Insert bill header
    const [billResult] = await connection.execute(
      `INSERT INTO bills (bill_number, customer_name, customer_phone, total_amount, created_by)
       VALUES (?, ?, ?, 0, ?)`,
      [`BILL-${Date.now()}`, customer_name, customer_phone, created_by]
    );

    const billId = billResult.insertId;
    let totalAmount = 0;

    // Process each item
    for (const item of items) {
  const [stockRows] = await connection.execute(
    "SELECT id, item_name, department, quantity FROM stock WHERE id = ? FOR UPDATE",
    [item.stock_id]
  );

  if (stockRows.length === 0) throw new Error(`Item not found: ${item.stock_id}`);
  const stockItem = stockRows[0];

  // ✅ Restriction
if (
  user_role === "operator" &&
  stockItem.department.toLowerCase() !== user_department.toLowerCase()
) {
  throw new Error(`You cannot bill items outside your department: ${stockItem.item_name}`);
}


   if (stockItem.quantity < item.quantity) {
  throw new Error(`Not enough stock for ${stockItem.item_name}`);
}

     const unitPrice = item.price || 100;

      // Deduct stock
     await connection.execute(
  "UPDATE stock SET quantity = quantity - ? WHERE id = ?",
  [item.quantity, item.stock_id]
);


      const lineTotal = unitPrice * item.quantity;
      totalAmount += lineTotal;

      // Insert bill item
     await connection.execute(
  `INSERT INTO bill_items (bill_id, stock_id, quantity,price, total)
   VALUES (?, ?, ?, ?, ?)`,
  [billId, item.stock_id, item.quantity, unitPrice, lineTotal]
);


      // Log transaction
      await logStockTransaction(
        item.stock_id,
        "OUT",
        item.quantity,
        lineTotal,
        created_by,
        `Billed in #${billId}`
      );
    }

    // Update bill total
    await connection.execute("UPDATE bills SET total_amount = ? WHERE id = ?", [totalAmount, billId]);

    await connection.commit();
    res.json({ success: true, bill_id: billId, total: totalAmount });
  } catch (err) {
    await connection.rollback();
    res.status(400).json({ success: false, message: err.message });
  } finally {
    connection.release();
  }
});
// Get stock items (filtered by operator department if operator)
app.get("/stock", async (req, res) => {
  const { operatorId } = req.query;

  try {
    // 1️⃣ Fetch operator role + department
    const [opRows] = await pool.execute(
      "SELECT role, department FROM operators WHERE id = ?",
      [operatorId]
    );

    if (opRows.length === 0) {
      return res.status(404).json({ success: false, message: "Operator not found" });
    }

    const { role, department } = opRows[0];

    // 2️⃣ Return filtered stock
    let query = "SELECT * FROM stock";
    let values = [];

    if (role === "operator") {
      query += " WHERE department = ?";
      values.push(department);
    }

    const [rows] = await pool.execute(query, values);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("Error fetching stock:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});




// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`)
  testConnection()
  startLowStockMonitor()
})