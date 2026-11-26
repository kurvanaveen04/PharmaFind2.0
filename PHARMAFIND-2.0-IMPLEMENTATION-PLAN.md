# PharmaFind 2.0 — rebuild plan and implementation status

This is a cleanly renamed working baseline from the supplied PharmaFind-Working-Website archive. It is not yet the completed 2.0 feature release.

## Included baseline
- React + Vite customer and pharmacy-owner interface
- Express API with authentication, medicine listings, pharmacy listings, inventory and orders
- Supabase SQL schema and server-side Supabase client scaffold
- Local JSON persistence currently used by the API

## Important current limitation
The current backend uses `backend/data/db.json`. The Supabase client and SQL schema exist, but the API repository has not yet been migrated to Supabase. Do not deploy this as a Supabase-connected production system until that migration is completed and tested.

## PharmaFind 2.0 features to implement and verify
1. Supabase-backed persistence and migrations
2. Admin role, protected admin dashboard, pharmacy approval and moderation
3. Inventory low-stock thresholds and expiry-date alerts
4. Leaflet + OpenStreetMap map, browser geolocation permission, pharmacy coordinates and directions
5. Medicine alternatives sourced from a curated catalogue and requiring pharmacist confirmation where clinically relevant
6. Gemini assistant that checks live inventory through backend APIs; never expose the Gemini key in the browser and never invent availability
7. Customer order tracking with auditable status history

## Safety and deployment notes
- Keep backend secrets in backend environment variables only. Never commit `.env`.
- Use `SUPABASE_SERVICE_ROLE_KEY` only on the server.
- The sample pharmacy, medicine and account data are demo data, not verified real businesses or live stock.
- Do not use AI to diagnose, prescribe, recommend dosage changes or independently substitute prescription medicines. Route clinical questions to a qualified pharmacist/doctor.
- Before real-world pharmacy transactions, verify applicable licensing, prescription, privacy and consumer-protection requirements.

## Suggested development order
Supabase repository migration -> auth/roles/admin -> inventory expiry and low-stock -> maps -> order tracking -> alternatives catalogue -> Gemini assistant -> full regression tests -> deployment.

## Owner portal usability update
- Added a medicine catalogue endpoint for the owner inventory form.
- Owners select a medicine from a dropdown instead of typing its name; common metadata and suggested price are prefilled.
- Owners enter quantity and selling price, with optional expiry date.
- First-run demo seed creates CarePlus, HealthFirst and MediCare owner accounts and loads the sample catalogue into all three demo pharmacies.
- Demo credentials and the owner workflow are documented in README.md.
