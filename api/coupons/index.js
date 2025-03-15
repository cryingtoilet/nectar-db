import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

export default async function handler(req, res) {
  switch (req.method) {
    case "GET":
      const { domain } = req.query;
      const { data, error } = await supabase
        .from("coupons")
        .select("code, discount, terms, verified")
        .eq("domain", domain)
        .gte(
          "created_at",
          new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
        );

      if (error) return res.status(500).json({ error: error.message });
      res.status(200).json({ coupons: data });
      break;

    case "POST":
      const { domain: postDomain, coupons } = req.body;

      // Better deduplication - ensures unique domain+code combinations
      const uniqueMap = new Map();
      coupons.forEach((coupon) => {
        const key = `${postDomain}:${coupon.code}`;
        // Only keep the first occurrence of each domain+code combination
        if (!uniqueMap.has(key)) {
          uniqueMap.set(key, {
            domain: postDomain,
            code: coupon.code,
            discount: coupon.discount,
            terms: coupon.terms,
            verified: coupon.verified,
          });
        }
      });

      const uniqueCoupons = Array.from(uniqueMap.values());

      // Now proceed with the upsert
      const { data: postData, error: postError } = await supabase
        .from("coupons")
        .upsert(uniqueCoupons, {
          onConflict: ["domain", "code"], // Changed from 'domain,code' to ['domain', 'code']
          ignoreDuplicates: true, // Changed to true to be extra safe
        });

      if (postError) return res.status(500).json({ error: postError.message });
      res.status(200).json({ success: true });
      break;

    default:
      res.setHeader("Allow", ["GET", "POST"]);
      res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}
