const SUPABASE_URL = 'https://mcdifwxzshfvkkbjiruf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1jZGlmd3h6c2hmdmtrYmppcnVmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1MTA4MDQsImV4cCI6MjA4NzA4NjgwNH0.seUN-rypULfET8oc_Y4S1ksnq93lGO4Aj1uOnfTdixE';

const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
