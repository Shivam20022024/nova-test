import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('Missing environment variables SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY. Ensure .env is loaded and these values are defined.');
}

export const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false
  }
});

export async function ensureBucketsExist() {
  // 'mobile-evidence' holds the Android engine's screenshots, hierarchy dumps,
  // recordings and Appium logs. That engine writes to it from the Python side
  // (backend/mobile/artifact_store.py) and creates it on demand if missing, but
  // listing it here means a fresh environment is provisioned up front rather
  // than on the first failed upload.
  const requiredBuckets = ['screenshots', 'videos', 'reports', 'exports', 'mobile-evidence'];
  const { data: existingBuckets, error } = await supabase.storage.listBuckets();
  
  if (error) {
    console.error('Failed to list buckets:', error);
    return;
  }
  
  const existingBucketNames = existingBuckets.map(b => b.name);
  
  for (const bucket of requiredBuckets) {
    if (!existingBucketNames.includes(bucket)) {
      console.log(`Creating missing bucket: ${bucket}`);
      await supabase.storage.createBucket(bucket, {
        public: true,
        fileSizeLimit: 52428800, // 50MB
      });
    }
  }
}
