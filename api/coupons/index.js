import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

export default async function handler(req, res) {
  switch (req.method) {
    case 'GET':
      const { domain } = req.query;
      const { data, error } = await supabase
        .from('coupons')
        .select('code, discount, terms, verified')
        .eq('domain', domain)
        .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
      
      if (error) return res.status(500).json({ error: error.message });
      res.status(200).json({ coupons: data });
      break;

      case 'POST':
        const { domain: postDomain, coupons } = req.body;
        
        // Deduplicate coupons before upsert
        const uniqueCoupons = coupons.reduce((acc, current) => {
          const exists = acc.find(c => 
            c.domain === postDomain && 
            c.code === current.code
          );
          return exists ? acc : [...acc, current];
        }, []);
      
        const { data: postData, error: postError } = await supabase
          .from('coupons')
          .upsert(
            uniqueCoupons.map(c => ({
              domain: postDomain,
              code: c.code,
              discount: c.discount,
              terms: c.terms,
              verified: c.verified
            })), 
            { 
              onConflict: ['domain,code'], // Use proper conflict resolution
              ignoreDuplicates: false 
            }
          );
      
      if (postError) return res.status(500).json({ error: postError.message });
      res.status(200).json({ success: true });
      break;

    default:
      res.setHeader('Allow', ['GET', 'POST']);
      res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}