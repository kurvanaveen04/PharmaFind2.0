
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const supabaseAdmin = require('./config/supabase');

const DB_FILE = path.join(__dirname, 'data', 'db.json');
const DEMO_PASSWORD = 'Demo@123';

async function checkError(result, action) {
  if (result.error) {
    throw new Error(`${action}: ${result.error.message}`);
  }
  return result.data;
}

async function migrate() {
  console.log('Starting PharmaFind 2.0 migration...');

  if (!fs.existsSync(DB_FILE)) {
    throw new Error('db.json not found inside backend/data');
  }

  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));

  const userIds = {};
  const pharmacyIds = {};
  const categoryIds = {};
  const medicineIds = {};

  // 1. Create or find demo owner accounts.
  for (const user of db.users) {
    let authUser;

    const existing = await checkError(
      await supabaseAdmin.auth.admin.listUsers({
        page: 1,
        perPage: 1000
      }),
      'Reading Supabase users'
    );

    authUser = existing.users.find(
      item => item.email?.toLowerCase() === user.email.toLowerCase()
    );

    if (!authUser) {
      const created = await checkError(
        await supabaseAdmin.auth.admin.createUser({
          email: user.email,
          password: DEMO_PASSWORD,
          email_confirm: true,
          user_metadata: {
            full_name: user.name
          }
        }),
        `Creating ${user.email}`
      );

      authUser = created.user;
    }

    userIds[user.id] = authUser.id;

    await checkError(
      await supabaseAdmin
        .from('profiles')
        .update({
          full_name: user.name,
          role: 'owner'
        })
        .eq('id', authUser.id),
      `Updating profile for ${user.email}`
    );

    console.log(`Owner ready: ${user.email}`);
  }

  // 2. Transfer pharmacies.
  for (const pharmacy of db.pharmacies) {
    const ownerId = userIds[pharmacy.ownerId];

    if (!ownerId) {
      throw new Error(`Owner not found for ${pharmacy.name}`);
    }

    let result = await supabaseAdmin
      .from('pharmacies')
      .select('id')
      .eq('owner_id', ownerId)
      .eq('name', pharmacy.name)
      .maybeSingle();

    if (result.error) {
      throw result.error;
    }

    let savedPharmacy = result.data;

    if (!savedPharmacy) {
      savedPharmacy = await checkError(
        await supabaseAdmin
          .from('pharmacies')
          .insert({
            owner_id: ownerId,
            name: pharmacy.name,
            address: pharmacy.address,
            city: pharmacy.city || 'Hyderabad',
            phone: pharmacy.phone,
            description: pharmacy.description,
            verified: pharmacy.verified
          })
          .select('id')
          .single(),
        `Creating pharmacy ${pharmacy.name}`
      );
    }

    pharmacyIds[pharmacy.id] = savedPharmacy.id;

    console.log(`Pharmacy ready: ${pharmacy.name}`);
  }

  // 3. Create categories.
  const categories = [
    ...new Set(db.inventory.map(item => item.category))
  ];

  for (const name of categories) {
    const category = await checkError(
      await supabaseAdmin
        .from('categories')
        .upsert(
          { category_name: name },
          { onConflict: 'category_name' }
        )
        .select('id')
        .single(),
      `Saving category ${name}`
    );

    categoryIds[name] = category.id;
  }

  // 4. Create unique medicine catalogue entries.
  for (const item of db.inventory) {
    const key = [
      item.name,
      item.genericName,
      item.brand,
      item.form
    ].join('|');

    if (medicineIds[key]) continue;

    let result = await supabaseAdmin
      .from('medicines')
      .select('id')
      .eq('name', item.name)
      .eq('brand', item.brand || 'Generic')
      .maybeSingle();

    if (result.error) throw result.error;

    let medicine = result.data;

    if (!medicine) {
      medicine = await checkError(
        await supabaseAdmin
          .from('medicines')
          .insert({
            name: item.name,
            generic_name: item.genericName,
            brand: item.brand || 'Generic',
            category_id: categoryIds[item.category],
            dosage_form: item.form,
            prescription_required: Boolean(item.prescription),
            description: item.description || ''
          })
          .select('id')
          .single(),
        `Creating medicine ${item.name}`
      );
    }

    medicineIds[key] = medicine.id;
  }

  // 5. Transfer pharmacy inventory and expiry batches.
  for (const item of db.inventory) {
    const pharmacyId = pharmacyIds[item.pharmacyId];

    const key = [
      item.name,
      item.genericName,
      item.brand,
      item.form
    ].join('|');

    const medicineId = medicineIds[key];

    if (!pharmacyId || !medicineId) {
      throw new Error(`Missing pharmacy or medicine for ${item.name}`);
    }

    const inventory = await checkError(
      await supabaseAdmin
        .from('inventory')
        .upsert(
          {
            pharmacy_id: pharmacyId,
            medicine_id: medicineId,
            price: item.price,
            stock: item.stock,
            low_stock_threshold: 10
          },
          { onConflict: 'pharmacy_id,medicine_id' }
        )
        .select('id')
        .single(),
      `Saving inventory for ${item.name}`
    );

    if (item.expiryDate) {
      const existingBatch = await supabaseAdmin
        .from('inventory_batches')
        .select('id')
        .eq('inventory_id', inventory.id)
        .eq('expiry_date', item.expiryDate)
        .maybeSingle();

      if (existingBatch.error) throw existingBatch.error;

      if (!existingBatch.data) {
        await checkError(
          await supabaseAdmin
            .from('inventory_batches')
            .insert({
              inventory_id: inventory.id,
              quantity: item.stock,
              expiry_date: item.expiryDate,
              batch_number: 'DEMO-' + item.id.slice(0, 8)
            }),
          `Saving expiry batch for ${item.name}`
        );
      }
    }
  }

  console.log('');
  console.log('MIGRATION COMPLETED SUCCESSFULLY');
  console.log('Owners:', db.users.length);
  console.log('Pharmacies:', db.pharmacies.length);
  console.log('Inventory records:', db.inventory.length);
  console.log('Medicine catalogue:', Object.keys(medicineIds).length);
  console.log('Original db.json was not modified.');
}

migrate().catch(error => {
  console.error('');
  console.error('MIGRATION FAILED:', error.message);
  process.exitCode = 1;
});
