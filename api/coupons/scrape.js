// File: api/coupons/scrape.js
import { createClient } from "@supabase/supabase-js";
import puppeteer from "puppeteer-core";
import chrome from "@sparticuz/chromium";

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Browser resources pool
let browserInstance = null;
let browserLastUsed = null;

// Browser management
async function getBrowser() {
  const currentTime = Date.now();

  // Reuse browser if it exists and was used in the last 2 minutes
  if (
    browserInstance &&
    browserLastUsed &&
    currentTime - browserLastUsed < 120000
  ) {
    browserLastUsed = currentTime;
    return browserInstance;
  }

  // Close old browser if it exists
  if (browserInstance) {
    try {
      await browserInstance.close();
    } catch (e) {
      console.error("Error closing browser:", e);
    }
  }

  // Launch new browser with optimized settings
  browserInstance = await puppeteer.launch({
    args: [
      ...chrome.args,
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      // Don't disable JavaScript or web security to ensure coupon sites work properly
    ],
    defaultViewport: { width: 1024, height: 768 },
    executablePath: await chrome.executablePath(),
    headless: true,
    ignoreHTTPSErrors: true,
  });

  browserLastUsed = currentTime;
  return browserInstance;
}

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { domain } = req.body;

  if (!domain) {
    return res.status(400).json({ error: "Domain parameter is required" });
  }

  // Send an immediate response to prevent timeout
  res.status(202).json({ message: "Scraping started" });

  // Continue processing asynchronously
  try {
    const coupons = await scrapeCoupons(domain);

    // Store the scraped coupons in Supabase
    await supabase.from("coupons").upsert(
      {
        domain,
        coupons,
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "domain",
      }
    );

    console.log(
      `Successfully scraped and stored ${coupons.length} coupons for ${domain}`
    );
  } catch (error) {
    console.error(`Error scraping coupons for ${domain}:`, error);
  }
}

// Optimized scraper with batch processing
async function scrapeCoupons(domain) {
  let browser = null;
  const BATCH_SIZE = 10; // Process coupons in batches of 10
  const MAX_CONCURRENT = 3; // Maximum number of concurrent page operations

  try {
    browser = await getBrowser();

    // Create a primary page for the initial scrape
    const page = await browser.newPage();
    page.setJavaScriptEnabled(true);

    // Selective resource blocking - block only unnecessary resources
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const resourceType = req.resourceType();
      if (resourceType === "image" || resourceType === "font") {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    );

    // Navigate to CouponFollow with optimized settings
    const url = `https://couponfollow.com/site/${domain}`;

    await page.goto(url, {
      waitUntil: "networkidle2", // Wait until network is idle for better JS execution
      timeout: 15000,
    });

    // Wait for coupon elements with better error handling
    try {
      await page.waitForSelector(".offer-card.regular-offer", {
        timeout: 8000,
      });
    } catch (err) {
      console.log("Selector timeout, continuing with extraction");
    }

    // Extract basic coupon data
    const basicCoupons = await page.evaluate(() => {
      const coupons = [];
      let idCounter = 1;

      const couponElements = document.querySelectorAll(
        ".offer-card.regular-offer"
      );

      couponElements.forEach((element) => {
        const dataType = element.getAttribute("data-type");
        if (dataType !== "coupon") return;

        const discountEl = element.querySelector(".offer-title");
        const termsEl = element.querySelector(".offer-description");
        const discount = discountEl?.textContent?.trim() || "Discount";
        const terms = termsEl?.textContent?.trim() || "Terms apply";
        const verified = element.getAttribute("data-is-verified") === "True";
        const modalUrl = element.getAttribute("data-modal");

        // Get code directly if possible
        let code = "AUTOMATIC";
        const codeEl = element.querySelector(".coupon-code");
        if (codeEl && codeEl.textContent) {
          code = codeEl.textContent.trim();
        }

        coupons.push({
          id: idCounter++,
          code,
          discount,
          terms,
          verified,
          source: "CouponFollow",
          modalUrl,
        });
      });

      return coupons;
    });

    // Process all coupons in batches
    const completeCoupons = [];
    const pendingCoupons = basicCoupons.filter(
      (coupon) => coupon.modalUrl && coupon.code === "AUTOMATIC"
    );

    // We'll process everything, no more coupon limit
    for (let i = 0; i < pendingCoupons.length; i += BATCH_SIZE) {
      const batch = pendingCoupons.slice(i, i + BATCH_SIZE);
      console.log(
        `Processing batch ${i / BATCH_SIZE + 1} with ${batch.length} coupons`
      );

      // Process batch with concurrency limit
      const batchResults = await processBatch(browser, batch, MAX_CONCURRENT);

      // Add processed coupons to final list
      batchResults.forEach((processedCoupon) => {
        completeCoupons.push(processedCoupon);
      });
    }

    // Add coupons that didn't need modal processing
    basicCoupons
      .filter((coupon) => !(coupon.modalUrl && coupon.code === "AUTOMATIC"))
      .forEach((coupon) => {
        const { modalUrl, ...couponData } = coupon;
        completeCoupons.push(couponData);
      });

    // Sort by ID to maintain original order
    completeCoupons.sort((a, b) => a.id - b.id);

    return completeCoupons;
  } catch (error) {
    console.error("Error in scrapeCoupons:", error);
    return []; // Return empty array instead of throwing
  }
}

// Batch processing function with concurrency control
async function processBatch(browser, coupons, concurrentLimit) {
  const results = [];
  const queue = [...coupons];
  const inProgress = new Set();

  async function processNextItem() {
    if (queue.length === 0) return;

    const { modalUrl, ...couponData } = queue.shift();
    inProgress.add(couponData.id);

    try {
      const page = await browser.newPage();

      // Optimize page resources
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        const resourceType = req.resourceType();
        if (resourceType === "image" || resourceType === "font") {
          req.abort();
        } else {
          req.continue();
        }
      });

      // Set timeout for the entire operation
      const pagePromise = new Promise(async (resolve) => {
        const timeoutId = setTimeout(() => {
          resolve({ ...couponData });
          try {
            page.close();
          } catch (e) {
            /* ignore */
          }
        }, 8000);

        try {
          await page.goto(modalUrl, {
            waitUntil: "domcontentloaded",
            timeout: 6000,
          });

          // Try to find the code
          const code = await page.evaluate(() => {
            const codeElement = document.querySelector(
              "input#code.input.code, input.input.code"
            );
            return codeElement ? codeElement.value.trim() : null;
          });

          if (code) {
            couponData.code = code;
          }

          clearTimeout(timeoutId);
          resolve({ ...couponData });
        } catch (error) {
          console.error(`Error processing coupon ${couponData.id}:`, error);
          clearTimeout(timeoutId);
          resolve({ ...couponData });
        } finally {
          try {
            await page.close();
          } catch (e) {
            /* ignore */
          }
        }
      });

      const result = await pagePromise;
      results.push(result);
    } catch (e) {
      console.error(`Error in page creation for coupon ${couponData.id}:`, e);
      results.push({ ...couponData });
    } finally {
      inProgress.delete(couponData.id);
    }

    // Start next item if queue is not empty and we're under concurrency limit
    if (queue.length > 0 && inProgress.size < concurrentLimit) {
      await processNextItem();
    }
  }

  // Start initial batch of concurrent operations
  const initialBatch = Math.min(concurrentLimit, queue.length);
  const initialPromises = [];

  for (let i = 0; i < initialBatch; i++) {
    initialPromises.push(processNextItem());
  }

  // Wait for all items to be processed
  await Promise.all(initialPromises);
  while (inProgress.size > 0) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return results;
}
