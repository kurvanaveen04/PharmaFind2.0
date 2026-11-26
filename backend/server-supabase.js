
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const supabaseAdmin = require('./config/supabase');

const app = express();
const PORT = process.env.PORT || 5000;

app.disable('x-powered-by');
app.use(helmet());
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:5173'
}));
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false
}));

function sendError(res, error, message = 'Server error') {
  console.error(message, error);
  return res.status(500).json({ message });
}

function safeUser(profile, email) {
  return {
    id: profile.id,
    name: profile.full_name,
    email,
    role: profile.role
  };
}

// Verify Supabase access tokens and load the user's role.
async function auth(req, res, next) {
  try {
    const token = (req.headers.authorization || '')
      .replace(/^Bearer\s+/i, '');

    if (!token) {
      return res.status(401).json({
        message: 'Please log in to continue'
      });
    }

    const { data, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !data.user) {
      return res.status(401).json({
        message: 'Session expired. Please log in again'
      });
    }

    const { data: profile, error: profileError } =
      await supabaseAdmin
        .from('profiles')
        .select('id, full_name, role, phone')
        .eq('id', data.user.id)
        .single();

    if (profileError || !profile) {
      return res.status(401).json({
        message: 'User profile not found'
      });
    }

    req.user = {
      ...safeUser(profile, data.user.email),
      phone: profile.phone
    };

    next();
  } catch (error) {
    return sendError(res, error, 'Authentication failed');
  }
}

const allow = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({
      message: 'You do not have permission for this action'
    });
  }
  next();
};

// Health check
app.get('/api/health', async (req, res) => {
  try {
    const { error } = await supabaseAdmin
      .from('categories')
      .select('id')
      .limit(1);

    if (error) throw error;

    res.json({
      status: 'ok',
      service: 'PharmaFind API',
      database: 'supabase',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return sendError(res, error, 'Database connection failed');
  }
});

// REGISTER
app.post('/api/auth/register', async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      role = 'customer',
      pharmacyName,
      address,
      phone
    } = req.body || {};

    if (!name || !email || !password) {
      return res.status(400).json({
        message: 'Name, email and password are required'
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        message: 'Password must be at least 8 characters'
      });
    }

    if (!['customer', 'owner'].includes(role)) {
      return res.status(400).json({
        message: 'Invalid account role'
      });
    }

    if (role === 'owner' && (!pharmacyName || !address)) {
      return res.status(400).json({
        message: 'Pharmacy name and address are required'
      });
    }

    const { data: created, error: createError } =
      await supabaseAdmin.auth.admin.createUser({
        email: email.toLowerCase().trim(),
        password,
        email_confirm: true,
        user_metadata: {
          full_name: name
        }
      });

    if (createError) {
      return res.status(400).json({
        message: createError.message
      });
    }

    const userId = created.user.id;

    const { data: profile, error: profileError } =
      await supabaseAdmin
        .from('profiles')
        .update({
          full_name: name,
          role,
          phone: phone || null
        })
        .eq('id', userId)
        .select()
        .single();

    if (profileError) {
      await supabaseAdmin.auth.admin.deleteUser(userId);
      throw profileError;
    }

    if (role === 'owner') {
      const { error: pharmacyError } =
        await supabaseAdmin
          .from('pharmacies')
          .insert({
            owner_id: userId,
            name: pharmacyName,
            address,
            city: 'Hyderabad',
            phone: phone || null,
            description: 'New pharmacy',
            verified: false
          });

      if (pharmacyError) {
        await supabaseAdmin.auth.admin.deleteUser(userId);
        throw pharmacyError;
      }
    }

    // Issue a normal user access token for the frontend.
    const loginClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false
        }
      }
    );

    const { data: session, error: loginError } =
      await loginClient.auth.signInWithPassword({
        email: email.toLowerCase().trim(),
        password
      });

    if (loginError || !session.session) {
      throw loginError || new Error('Could not create login session');
    }

    res.status(201).json({
      token: session.session.access_token,
      user: safeUser(profile, created.user.email)
    });

  } catch (error) {
    return sendError(res, error, 'Registration failed');
  }
});

// LOGIN
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({
        message: 'Email and password are required'
      });
    }

    const loginClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false
        }
      }
    );

    const { data, error } =
      await loginClient.auth.signInWithPassword({
        email: email.toLowerCase().trim(),
        password
      });

    if (error || !data.session) {
      return res.status(401).json({
        message: 'Invalid email or password'
      });
    }

    const { data: profile, error: profileError } =
      await supabaseAdmin
        .from('profiles')
        .select('id, full_name, role, phone')
        .eq('id', data.user.id)
        .single();

    if (profileError || !profile) {
      return res.status(401).json({
        message: 'User profile not found'
      });
    }

    res.json({
      token: data.session.access_token,
      user: safeUser(profile, data.user.email)
    });

  } catch (error) {
    return sendError(res, error, 'Login failed');
  }
});

// CURRENT USER
app.get('/api/auth/me', auth, (req, res) => {
  res.json({ user: req.user });
});

// MEDICINE SEARCH
app.get('/api/medicines', async (req, res) => {
  try {
    const { q = '', category = '', city = '', inStock } = req.query;

    let query = supabaseAdmin
      .from('inventory')
      .select(`
        id, pharmacy_id, medicine_id, price, stock,
        medicines (
          id, name, generic_name, brand,
          dosage_form, prescription_required, description,
          categories ( category_name )
        ),
        pharmacies (
          id, name, address, city, phone,
          latitude, longitude, verified
        )
      `);

    if (inStock === 'true') {
      query = query.gt('stock', 0);
    }

    const { data, error } = await query;

    if (error) throw error;

    let items = (data || []).map(row => ({
      id: row.id,
      pharmacyId: row.pharmacy_id,
      medicineId: row.medicine_id,
      name: row.medicines?.name,
      genericName: row.medicines?.generic_name,
      brand: row.medicines?.brand,
      category: row.medicines?.categories?.category_name,
      form: row.medicines?.dosage_form,
      prescription: row.medicines?.prescription_required,
      description: row.medicines?.description,
      price: Number(row.price),
      stock: row.stock,
      pharmacy: row.pharmacies
    }));

    const search = String(q).toLowerCase();
    const citySearch = String(city).toLowerCase();

    if (search) {
      items = items.filter(item =>
        [
          item.name,
          item.genericName,
          item.brand,
          item.category,
          item.pharmacy?.name,
          item.pharmacy?.address
        ].join(' ').toLowerCase().includes(search)
      );
    }

    if (category) {
      items = items.filter(item => item.category === category);
    }

    if (citySearch) {
      items = items.filter(item =>
        (item.pharmacy?.city + ' ' + item.pharmacy?.address)
          .toLowerCase().includes(citySearch)
      );
    }

    const categories = [
      ...new Set(items.map(item => item.category).filter(Boolean))
    ].sort();

    res.json({
      items,
      categories,
      count: items.length
    });

  } catch (error) {
    return sendError(res, error, 'Could not load medicines');
  }
});

// PHARMACY LIST
app.get('/api/pharmacies', async (req, res) => {
  try {
    const { data: pharmacies, error } = await supabaseAdmin
      .from('pharmacies')
      .select('*')
      .order('name');

    if (error) throw error;

    const { data: inventory, error: inventoryError } =
      await supabaseAdmin
        .from('inventory')
        .select('pharmacy_id');

    if (inventoryError) throw inventoryError;

    let items = (pharmacies || []).map(pharmacy => ({
      ...pharmacy,
      medicineCount: (inventory || []).filter(
        item => item.pharmacy_id === pharmacy.id
      ).length
    }));

    const q = String(req.query.q || '').toLowerCase();

    if (q) {
      items = items.filter(pharmacy =>
        `${pharmacy.name} ${pharmacy.address} ${pharmacy.city}`
          .toLowerCase().includes(q)
      );
    }

    res.json({ items });

  } catch (error) {
    return sendError(res, error, 'Could not load pharmacies');
  }
});

// PHARMACY DETAILS
app.get('/api/pharmacies/:id', async (req, res) => {
  try {
    const { data: pharmacy, error } = await supabaseAdmin
      .from('pharmacies')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error || !pharmacy) {
      return res.status(404).json({
        message: 'Pharmacy not found'
      });
    }

    const { data: inventory, error: inventoryError } =
      await supabaseAdmin
        .from('inventory')
        .select(`
          id, pharmacy_id, medicine_id, price, stock,
          medicines (
            id, name, generic_name, brand,
            dosage_form, prescription_required, description,
            categories ( category_name )
          )
        `)
        .eq('pharmacy_id', pharmacy.id);

    if (inventoryError) throw inventoryError;

    const items = (inventory || []).map(row => ({
      id: row.id,
      pharmacyId: row.pharmacy_id,
      medicineId: row.medicine_id,
      name: row.medicines?.name,
      genericName: row.medicines?.generic_name,
      brand: row.medicines?.brand,
      category: row.medicines?.categories?.category_name,
      form: row.medicines?.dosage_form,
      prescription: row.medicines?.prescription_required,
      description: row.medicines?.description,
      price: Number(row.price),
      stock: row.stock
    }));

    res.json({ ...pharmacy, inventory: items });

  } catch (error) {
    return sendError(res, error, 'Could not load pharmacy');
  }
});

// MEDICINE CATALOGUE FOR OWNER INVENTORY FORM
app.get('/api/medicine-catalog', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('medicines')
      .select(`
        id, name, generic_name, brand,
        dosage_form, prescription_required,
        categories ( category_name )
      `)
      .order('name');

    if (error) throw error;

    res.json({
      items: (data || []).map(item => ({
        id: item.id,
        name: item.name,
        genericName: item.generic_name,
        brand: item.brand,
        form: item.dosage_form,
        category: item.categories?.category_name,
        prescription: item.prescription_required
      }))
    });

  } catch (error) {
    return sendError(res, error, 'Could not load medicine catalogue');
  }
});

// ==========================================
// OWNER DASHBOARD AND INVENTORY MANAGEMENT
// ==========================================

// Get owner's pharmacy and dashboard statistics

app.get('/api/owner/overview', auth, allow('owner'), async (req, res) => {
  try {
    const { data: pharmacy, error: pharmacyError } = await supabaseAdmin
      .from('pharmacies')
      .select('*')
      .eq('owner_id', req.user.id)
      .single();

    if (pharmacyError || !pharmacy) {
      return res.status(404).json({ message: 'Pharmacy not found' });
    }

    // Fetch pharmacy inventory
    const { data: inventory, error: inventoryError } = await supabaseAdmin
      .from('inventory')
      .select(`
        *,
        medicines (
          id, name, generic_name, brand,
          dosage_form, prescription_required, description
        ),
        inventory_batches (
          id, batch_number, quantity, expiry_date
        )
      `)
      .eq('pharmacy_id', pharmacy.id);

    if (inventoryError) throw inventoryError;

    // Fetch orders, customer profiles and order items
    const { data: orders, error: ordersError } = await supabaseAdmin
      .from('orders')
      .select(`
        *,
        profiles (*),
        order_items (*)
      `)
      .eq('pharmacy_id', pharmacy.id)
      .order('created_at', { ascending: false });

    if (ordersError) throw ordersError;

    // Format inventory for frontend
    const items = (inventory || []).map(item => ({
      id: item.id,
      pharmacyId: item.pharmacy_id,
      medicineId: item.medicine_id,
      name: item.medicines?.name,
      genericName: item.medicines?.generic_name,
      brand: item.medicines?.brand,
      category: item.medicines?.category,
      form: item.medicines?.dosage_form,
      prescription: item.medicines?.prescription_required,
      description: item.medicines?.description,
      price: Number(item.price),
      stock: item.stock,
      lowStockThreshold: item.low_stock_threshold,
      batches: item.inventory_batches || [],
      expiryDate: item.inventory_batches?.[0]?.expiry_date || ''
    }));

    // Format orders for frontend
    const formattedOrders = (orders || []).map(order => {
      const customer = order.profiles || {};

      return {
        id: order.id,
        createdAt: order.created_at,
        status: order.status,
        total: Number(order.subtotal),
        subtotal: Number(order.subtotal),
        customerName:
          customer.full_name ||
          customer.name ||
          customer.email ||
          'Customer',
        phone: order.contact_phone || customer.phone || '',
        address: order.delivery_address || '',
        items: (order.order_items || []).map(item => ({
          inventoryId: item.inventory_id,
          name: item.medicine_name,
          quantity: item.quantity,
          price: Number(item.unit_price)
        }))
      };
    });

    return res.json({
      pharmacy,
      inventory: items,
      orders: formattedOrders,
      stats: {
        products: items.length,
        lowStock: items.filter(
          item => item.stock <= item.lowStockThreshold
        ).length,
        pendingOrders: formattedOrders.filter(
          order => order.status === 'Pending'
        ).length,
        totalOrders: formattedOrders.length
      }
    });

  } catch (error) {
    return sendError(res, error, 'Could not load owner dashboard');
  }
});


// Add medicine to owner's inventory
app.post('/api/owner/inventory', auth, allow('owner'), async (req, res) => {
  try {
    const {
      medicineId, name, price, stock,
      expiryDate, batchNumber, lowStockThreshold
    } = req.body || {};

    if (
      !Number.isFinite(Number(price)) || Number(price) < 0 ||
      !Number.isInteger(Number(stock)) || Number(stock) < 0 ||
      !expiryDate
    ) {
      return res.status(400).json({
        message: 'Enter a valid price, stock quantity and expiry date'
      });
    }

    const { data: pharmacy, error: pharmacyError } = await supabaseAdmin
      .from('pharmacies')
      .select('id')
      .eq('owner_id', req.user.id)
      .single();

    if (pharmacyError || !pharmacy) {
      return res.status(404).json({ message: 'Pharmacy not found' });
    }

    let medicineQuery = supabaseAdmin
      .from('medicines')
      .select('id, name');

    if (medicineId) {
      medicineQuery = medicineQuery.eq('id', medicineId);
    } else if (name) {
      medicineQuery = medicineQuery.ilike('name', name);
    } else {
      return res.status(400).json({
        message: 'Select a medicine from the catalogue'
      });
    }

    const { data: medicine, error: medicineError } =
      await medicineQuery.single();

    if (medicineError || !medicine) {
      return res.status(404).json({ message: 'Medicine not found in catalogue' });
    }

    const { data: existing } = await supabaseAdmin
      .from('inventory')
      .select('id, stock')
      .eq('pharmacy_id', pharmacy.id)
      .eq('medicine_id', medicine.id)
      .maybeSingle();

    let inventoryItem;

    if (existing) {
      const { data, error } = await supabaseAdmin
        .from('inventory')
        .update({
          price: Number(price),
          stock: existing.stock + Number(stock),
          low_stock_threshold: Number(lowStockThreshold ?? 10),
          updated_at: new Date().toISOString()
        })
        .eq('id', existing.id)
        .select()
        .single();

      if (error) throw error;
      inventoryItem = data;
    } else {
      const { data, error } = await supabaseAdmin
        .from('inventory')
        .insert({
          pharmacy_id: pharmacy.id,
          medicine_id: medicine.id,
          price: Number(price),
          stock: Number(stock),
          low_stock_threshold: Number(lowStockThreshold ?? 10)
        })
        .select()
        .single();

      if (error) throw error;
      inventoryItem = data;
    }

    const { error: batchError } = await supabaseAdmin
      .from('inventory_batches')
      .insert({
        inventory_id: inventoryItem.id,
        batch_number: batchNumber || null,
        quantity: Number(stock),
        expiry_date: expiryDate
      });

    if (batchError) throw batchError;

    res.status(201).json({
      message: 'Medicine added successfully',
      item: inventoryItem
    });
  } catch (error) {
    return sendError(res, error, 'Could not add medicine');
  }
});


// Update inventory price and stock
app.put('/api/owner/inventory/:id', auth, allow('owner'), async (req, res) => {
  try {
    const { data: pharmacy, error: pharmacyError } = await supabaseAdmin
      .from('pharmacies')
      .select('id')
      .eq('owner_id', req.user.id)
      .single();

    if (pharmacyError || !pharmacy) {
      return res.status(404).json({ message: 'Pharmacy not found' });
    }

    const updates = {};

    if (req.body.price !== undefined) {
      if (!Number.isFinite(Number(req.body.price)) || Number(req.body.price) < 0) {
        return res.status(400).json({ message: 'Invalid price' });
      }
      updates.price = Number(req.body.price);
    }

    if (req.body.stock !== undefined) {
      if (!Number.isInteger(Number(req.body.stock)) || Number(req.body.stock) < 0) {
        return res.status(400).json({ message: 'Invalid stock quantity' });
      }
      updates.stock = Number(req.body.stock);
    }

    if (req.body.lowStockThreshold !== undefined) {
      updates.low_stock_threshold = Number(req.body.lowStockThreshold);
    }

    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from('inventory')
      .update(updates)
      .eq('id', req.params.id)
      .eq('pharmacy_id', pharmacy.id)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ message: 'Inventory item not found' });
    }

    res.json({ message: 'Inventory updated successfully', item: data });
  } catch (error) {
    return sendError(res, error, 'Could not update inventory');
  }
});


// Remove medicine from owner's inventory
app.delete('/api/owner/inventory/:id', auth, allow('owner'), async (req, res) => {
  try {
    const { data: pharmacy, error: pharmacyError } = await supabaseAdmin
      .from('pharmacies')
      .select('id')
      .eq('owner_id', req.user.id)
      .single();

    if (pharmacyError || !pharmacy) {
      return res.status(404).json({ message: 'Pharmacy not found' });
    }

    const { error } = await supabaseAdmin
      .from('inventory')
      .delete()
      .eq('id', req.params.id)
      .eq('pharmacy_id', pharmacy.id);

    if (error) throw error;

    res.json({ message: 'Medicine removed from inventory' });
  } catch (error) {
    return sendError(res, error, 'Could not remove medicine');
  }
});
// Admin dashboard overview
app.get('/api/admin/overview', auth, allow('admin'), async (req, res) => {
  try {
    const [customers, owners, medicines, orders] = await Promise.all([
      supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'customer'),
      supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'owner'),
      supabaseAdmin.from('medicines').select('id', { count: 'exact', head: true }),
      supabaseAdmin.from('orders').select('id', { count: 'exact', head: true })
    ]);

    const error = customers.error || owners.error || medicines.error || orders.error;
    if (error) throw error;

    res.json({
      customers: customers.count || 0,
      owners: owners.count || 0,
      medicines: medicines.count || 0,
      orders: orders.count || 0
    }); 
    // Admin: List all pharmacies
  } catch (error) {
    return sendError(res, error, 'Could not load admin dashboard');
  }
}); 
// Admin: List customers and pharmacy owners
app.get('/api/admin/users', auth, allow('admin'), async (req, res) => {
  try {
    const { data: profiles, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, role, phone, created_at')
      .in('role', ['customer', 'owner'])
      .order('created_at', { ascending: false });

    if (profileError) throw profileError;

    const { data: authData, error: authError } =
      await supabaseAdmin.auth.admin.listUsers({
        page: 1,
        perPage: 1000
      });

    if (authError) throw authError;

    const users = profiles.map(profile => {
      const account = authData.users.find(
        user => user.id === profile.id
      );

      return {
        ...profile,
        email: account?.email || 'Unavailable'
      };
    });

    res.json({
      customers: users.filter(user => user.role === 'customer'),
      owners: users.filter(user => user.role === 'owner')
    });
  } catch (error) {
    return sendError(res, error, 'Could not load users');
  }
});
 
// ADMIN: MEDICINE MANAGEMENT

// List and search medicines
app.get('/api/admin/medicines', auth, allow('admin'), async (req, res) => {
  try {
    let query = supabaseAdmin
      .from('medicines')
      .select('id, name, generic_name, brand, category_id, dosage_form, prescription_required, description, created_at')
      .order('name');

    if (req.query.search) {
      query = query.ilike('name', `%${req.query.search}%`);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({ medicines: data || [] });
  } catch (error) {
    return sendError(res, error, 'Could not load medicines');
  }
});

// Add a medicine
app.post('/api/admin/medicines', auth, allow('admin'), async (req, res) => {
  try {
    const {
      name, generic_name, brand, category_id,
      dosage_form, prescription_required, description
    } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ message: 'Medicine name is required' });
    }

    const { data, error } = await supabaseAdmin
      .from('medicines')
      .insert({
        name: name.trim(),
        generic_name: generic_name || null,
        brand: brand || null,
        category_id: category_id || null,
        dosage_form: dosage_form || null,
        prescription_required: prescription_required === true,
        description: description || null
      })
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({ message: 'Medicine added', medicine: data });
  } catch (error) {
    return sendError(res, error, 'Could not add medicine');
  }
});

// Edit a medicine
app.patch('/api/admin/medicines/:id', auth, allow('admin'), async (req, res) => {
  try {
    const allowed = [
      'name', 'generic_name', 'brand', 'category_id',
      'dosage_form', 'prescription_required', 'description'
    ];

    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: 'No medicine details provided' });
    }

    const { data, error } = await supabaseAdmin
      .from('medicines')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;

    res.json({ message: 'Medicine updated', medicine: data });
  } catch (error) {
    return sendError(res, error, 'Could not update medicine');
  }
});

// Delete a medicine only when it is not used in pharmacy inventory
app.delete('/api/admin/medicines/:id', auth, allow('admin'), async (req, res) => {
  try {
    const { count, error: checkError } = await supabaseAdmin
      .from('inventory')
      .select('id', { count: 'exact', head: true })
      .eq('medicine_id', req.params.id);

    if (checkError) throw checkError;

    if (count > 0) {
      return res.status(409).json({
        message: 'This medicine is used in pharmacy inventory and cannot be deleted'
      });
    }

    const { error } = await supabaseAdmin
      .from('medicines')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;

    res.json({ message: 'Medicine deleted' });
  } catch (error) {
    return sendError(res, error, 'Could not delete medicine');
  }
});


// ADMIN: ORDER MONITORING

app.get('/api/admin/orders', auth, allow('admin'), async (req, res) => {
  try {
    const { data: orders, error } = await supabaseAdmin
      .from('orders')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    const customerIds = [...new Set((orders || []).map(o => o.customer_id))];
    const pharmacyIds = [...new Set((orders || []).map(o => o.pharmacy_id))];
    const orderIds = (orders || []).map(o => o.id);

    const [profilesResult, pharmaciesResult, itemsResult] = await Promise.all([
      customerIds.length
        ? supabaseAdmin.from('profiles').select('id, full_name, phone').in('id', customerIds)
        : Promise.resolve({ data: [], error: null }),

      pharmacyIds.length
        ? supabaseAdmin.from('pharmacies').select('id, name, city').in('id', pharmacyIds)
        : Promise.resolve({ data: [], error: null }),

      orderIds.length
        ? supabaseAdmin.from('order_items').select('*').in('order_id', orderIds)
        : Promise.resolve({ data: [], error: null })
    ]);

    const errorFound =
      profilesResult.error || pharmaciesResult.error || itemsResult.error;

    if (errorFound) throw errorFound;

    const profiles = profilesResult.data || [];
    const pharmacies = pharmaciesResult.data || [];
    const items = itemsResult.data || [];

    const result = (orders || []).map(order => ({
      ...order,
      customer: profiles.find(p => p.id === order.customer_id) || null,
      pharmacy: pharmacies.find(p => p.id === order.pharmacy_id) || null,
      items: items.filter(item => item.order_id === order.id)
    }));

    res.json({ orders: result });
  } catch (error) {
    return sendError(res, error, 'Could not load orders');
  }
});

// Admin: List all pharmacies
app.get('/api/admin/pharmacies', auth, allow('admin'), async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('pharmacies')
      .select('id, owner_id, name, address, city, phone, latitude, longitude, verified, created_at')
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ pharmacies: data || [] });
  } catch (error) {
    return sendError(res, error, 'Could not load pharmacies');
  }
});

// Admin: Approve or reject a pharmacy
app.patch('/api/admin/pharmacies/:id/verification', auth, allow('admin'), async (req, res) => {
  try {
    const { verified } = req.body;

    if (typeof verified !== 'boolean') {
      return res.status(400).json({ message: 'Invalid verification status' });
    }

    const { data, error } = await supabaseAdmin
      .from('pharmacies')
      .update({ verified, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;

    res.json({ message: verified ? 'Pharmacy approved' : 'Pharmacy rejected', pharmacy: data });
  } catch (error) {
    return sendError(res, error, 'Could not update pharmacy status');
  }
}); 

// CUSTOMER: Place pickup orders
app.post('/api/orders', auth, allow('customer'), async (req, res) => {
  try {
    const { items, phone, fulfillmentType } = req.body;

    if (fulfillmentType !== 'pickup') {
      return res.status(400).json({
        message: 'Only pharmacy pickup is supported'
      });
    }

    if (!phone || !String(phone).trim()) {
      return res.status(400).json({
        message: 'Phone number is required'
      });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        message: 'Your cart is empty'
      });
    }

    const orderItems = items.map(item => ({
      inventoryId: item.inventoryId,
      quantity: Number(item.quantity)
    }));

    const { data, error } = await supabaseAdmin.rpc(
      'place_pickup_orders',
      {
        p_customer_id: req.user.id,
        p_contact_phone: String(phone).trim(),
        p_items: orderItems
      }
    );

    if (error) throw error;

    return res.status(201).json({
      message: 'Pickup order placed successfully',
      orders: data.orders
    });
  } catch (error) {
    return sendError(res, error, 'Could not place order');
  }
});

 // CUSTOMER / OWNER: Get orders
app.get('/api/orders', auth, allow('customer', 'owner'), async (req, res) => {
  try {
    let pharmacyId = null;

    if (req.user.role === 'owner') {
      const { data: pharmacy, error: pharmacyError } = await supabaseAdmin
        .from('pharmacies')
        .select('id')
        .eq('owner_id', req.user.id)
        .maybeSingle();

      if (pharmacyError) throw pharmacyError;

      if (!pharmacy) {
        return res.status(404).json({
          message: 'Pharmacy not found'
        });
      }

      pharmacyId = pharmacy.id;
    }

    let query = supabaseAdmin
      .from('orders')
      .select(`
        id,
        customer_id,
        pharmacy_id,
        status,
        delivery_address,
        contact_phone,
        subtotal,
        created_at,
        order_items (
          id,
          inventory_id,
          medicine_name,
          quantity,
          unit_price,
          total_price
        )
      `)
      .order('created_at', { ascending: false });

    if (req.user.role === 'customer') {
      query = query.eq('customer_id', req.user.id);
    } else {
      query = query.eq('pharmacy_id', pharmacyId);
    }

    const { data, error } = await query;

    if (error) throw error;

    const items = (data || []).map(order => ({
      id: order.id,
      createdAt: order.created_at,
      status: order.status,
      total: Number(order.subtotal),
      address: order.delivery_address,
      phone: order.contact_phone,
      customerName: 'Customer',
      items: (order.order_items || []).map(item => ({
        inventoryId: item.inventory_id,
        name: item.medicine_name,
        quantity: item.quantity,
        price: Number(item.unit_price)
      }))
    }));

    return res.json({ items });
  } catch (error) {
    return sendError(res, error, 'Could not fetch orders');
  }
});

// OWNER: Update order status
app.patch('/api/orders/:id/status', auth, allow('owner'), async (req, res) => {
  try {
    const { status } = req.body;

    
const allowedStatuses = [
  'Pending',
  'Confirmed',
  'Ready for pickup',
  'Completed',
  'Cancelled'
];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        message: 'Invalid order status'
      });
    }

    const { data: pharmacy, error: pharmacyError } = await supabaseAdmin
      .from('pharmacies')
      .select('id')
      .eq('owner_id', req.user.id)
      .maybeSingle();

    if (pharmacyError) throw pharmacyError;

    if (!pharmacy) {
      return res.status(404).json({
        message: 'Pharmacy not found'
      });
    }

    const { data, error } = await supabaseAdmin
      .from('orders')
      .update({
        status,
        updated_at: new Date().toISOString()
      })
      .eq('id', req.params.id)
      .eq('pharmacy_id', pharmacy.id)
      .select('id, status')
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({
        message: 'Order not found for your pharmacy'
      });
    }

    return res.json({
      message: 'Order status updated',
      order: data
    });
  } catch (error) {
    return sendError(res, error, 'Could not update order status');
  }
});

// Temporary 404 handler until the remaining routes are added.
app.use((req, res) => {
  res.status(404).json({ message: 'API route not found' });
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ message: 'Server error' });
});

app.listen(PORT, () => {
  console.log(`PharmaFind Supabase API running at http://localhost:${PORT}`);
});
