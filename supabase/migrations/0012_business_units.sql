-- ============================================================================
-- The business units named in spec section 15
--
-- Seeded, not hardcoded. Section 15 requires these to be editable, so they go
-- in as rows the owner can rename, reorder, deactivate or add to.
--
-- Idempotent: safe to re-run.
-- ============================================================================

insert into business_units (name, services, sort_order)
select * from (values
  ('Media', array['Content', 'Sponsorships', 'Newsletter', 'Social'], 10),
  ('Events', array['Conferences', 'Meetups', 'Workshops', 'Sponsored events'], 20),
  ('Membership / Community', array['Memberships', 'Community programmes'], 30),
  ('AHN Solutions / Agency', array['Agency retainers', 'Campaigns', 'Consulting'], 40),
  -- Section 15 lists these under AHN Labs explicitly.
  ('AHN Labs', array[
     'E-commerce development', 'Product sourcing', 'Manufacturing',
     'Fulfillment / 3PL', 'Content', 'Creator campaigns', 'TikTok Shop',
     'Livestreaming', 'Store operations', 'TSP / seller-store operations',
     'TAP / merchant-creator matchmaking', 'CAP / creator services and support'
   ], 50)
) as v(name, services, sort_order)
where not exists (select 1 from business_units where business_units.name = v.name);
