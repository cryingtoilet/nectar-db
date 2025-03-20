import { createClient } from "@supabase/supabase-js";
import puppeteer from "puppeteer-core";
import chrome from "@sparticuz/chromium";
import fs from "fs/promises";
import path from "path";

// Ensure logs directory exists
const LOGS_DIR = path.join(process.cwd(), "logs");
fs.mkdir(LOGS_DIR, { recursive: true }).catch(console.error);

// Create log file with timestamp
const LOG_FILE = path.join(
  LOGS_DIR,
  `scrape-${new Date().toISOString().replace(/:/g, "-")}.log`
);

// Setup logging to both console and file
const log = async (message, level = "INFO") => {
  const timestamp = new Date().toISOString();
  const formattedMessage = `[${timestamp}] [${level}] ${message}`;

  console.log(formattedMessage);

  // Also write to log file
  await fs.appendFile(LOG_FILE, formattedMessage + "\n").catch(console.error);
};

// Error logger
const logError = async (message, error) => {
  await log(`${message}: ${error.message}`, "ERROR");
  if (error.stack) {
    await log(error.stack, "ERROR");
  }
};

// Browser resources pool
let browserInstance = null;
let browserLastUsed = null;

// Configuration for scraping performance
const CONFIG = {
  concurrentDomains: process.env.CONCURRENT_DOMAINS
    ? parseInt(process.env.CONCURRENT_DOMAINS)
    : 5,
  batchSize: process.env.BATCH_SIZE ? parseInt(process.env.BATCH_SIZE) : 5,
  domainRetries: process.env.DOMAIN_RETRIES
    ? parseInt(process.env.DOMAIN_RETRIES)
    : 2,
  modalTimeout: process.env.MODAL_TIMEOUT
    ? parseInt(process.MODAL_TIMEOUT)
    : 10000,
  navigationTimeout: process.env.NAVIGATION_TIMEOUT
    ? parseInt(process.env.NAVIGATION_TIMEOUT)
    : 15000,
  delayBetweenDomains: process.env.DELAY_BETWEEN_DOMAINS
    ? parseInt(process.env.DELAY_BETWEEN_DOMAINS)
    : 1000,
  browserReuseTime: 120000, // Reuse browser if used in last 2 minutes
};

// Browser management
async function getBrowser() {
  const currentTime = Date.now();

  // Reuse browser if it exists and was used in the last 2 minutes
  if (
    browserInstance &&
    browserLastUsed &&
    currentTime - browserLastUsed < CONFIG.browserReuseTime
  ) {
    browserLastUsed = currentTime;
    return browserInstance;
  }

  // Close old browser if it exists
  if (browserInstance) {
    try {
      await browserInstance.close();
      await log("Closed existing browser instance");
    } catch (e) {
      await logError("Error closing browser", e);
    }
  }

  // Launch new browser with optimized settings
  await log("Launching new browser instance");
  browserInstance = await puppeteer.launch({
    args: [
      ...chrome.args,
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--disable-blink-features=AutomationControlled", // Helps avoid detection
      "--window-size=1920,1080", // Set a realistic window size
    ],
    defaultViewport: { width: 1024, height: 768 },
    executablePath: await chrome.executablePath(),
    headless: true,
    ignoreHTTPSErrors: true,
  });

  // Add anti-detection measures
  const pages = await browserInstance.pages();
  if (pages.length > 0) {
    await pages[0].evaluateOnNewDocument(() => {
      // Pass basic bot detection
      Object.defineProperty(navigator, "webdriver", {
        get: () => false,
      });
      // Override Chrome/Puppeteer specific properties
      window.navigator.chrome = { runtime: {} };
      window.navigator.permissions = {
        query: () => Promise.resolve({ state: "granted" }),
      };
    });
  }

  browserLastUsed = currentTime;
  return browserInstance;
}

/**
 * Scrapes domain names from CouponFollow's category page
 * @param {string} letter - The letter category (a-z or #) to scrape
 * @returns {Promise<string[]>} - Array of domain names
 */
async function scrapeDomains(letter) {
  await log(`Scraping domain list for letter: ${letter}...`);

  const browser = await getBrowser();

  try {
    const page = await browser.newPage();

    // Set a realistic user agent
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36"
    );

    // Set page options similar to coupon scraper
    await page.setJavaScriptEnabled(true);
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    });

    // Selective resource blocking to improve performance
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const resourceType = req.resourceType();
      if (resourceType === "image" || resourceType === "font") {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Override webdriver properties to avoid detection
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", {
        get: () => false,
      });
      window.navigator.chrome = { runtime: {} };
      window.navigator.permissions = {
        query: () => Promise.resolve({ state: "granted" }),
      };
    });

    page.setDefaultNavigationTimeout(CONFIG.navigationTimeout);

    // Navigate to the letter's category page
    const url = `https://couponfollow.com/site/browse/${letter}/all`;
    await log(`Navigating to ${url}...`);

    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: CONFIG.navigationTimeout,
    });

    await log(`Page loaded for letter ${letter}, extracting domains...`);

    // Extract domain names from the page
    const domains = await page.evaluate(() => {
      const domainList = [];

      // Each store is in a list item with a link
      const storeLinks = document.querySelectorAll('ul li a[href^="/site/"]');

      storeLinks.forEach((link) => {
        const href = link.getAttribute("href");
        if (href) {
          // Extract domain from the URL format "/site/domain.com"
          const domain = href.replace("/site/", "");
          if (domain) {
            domainList.push(domain);
          }
        }
      });

      return domainList;
    });

    await log(`Found ${domains.length} domains for letter ${letter}`);
    await page.close();
    return domains;
  } catch (error) {
    await logError(`Error scraping domains for letter ${letter}`, error);
    return [];
  }
}

/**
 * Scrapes coupons for a specific domain
 * @param {string} domain - The domain to scrape coupons for
 * @param {number} retryCount - Current retry attempt (internal use)
 * @returns {Promise<Array>} - Array of coupon objects
 */
async function scrapeCoupons(domain, retryCount = 0) {
  await log(`Scraping coupons for ${domain}...`);

  let browser = null;

  try {
    browser = await getBrowser();

    // Create a primary page for the initial scrape
    const page = await browser.newPage();

    // Set a realistic user agent
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36"
    );

    // Enable JavaScript
    await page.setJavaScriptEnabled(true);

    // Set extra headers to appear more like a real browser
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    });

    // Selective resource blocking to improve performance
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const resourceType = req.resourceType();
      if (resourceType === "image" || resourceType === "font") {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Override the navigator.webdriver property to avoid detection
    await page.evaluateOnNewDocument(() => {
      // Pass basic bot detection
      Object.defineProperty(navigator, "webdriver", {
        get: () => false,
      });
      // Override Chrome/Puppeteer specific properties
      window.navigator.chrome = { runtime: {} };
      window.navigator.permissions = {
        query: () => Promise.resolve({ state: "granted" }),
      };
    });

    // Set default navigation timeout
    page.setDefaultNavigationTimeout(CONFIG.navigationTimeout);

    // Add browser console logs to our logs
    page.on("console", (msg) =>
      log(`Browser console [${domain}]: ${msg.text()}`, "BROWSER")
    );

    await log(`Navigating to couponfollow.com for ${domain}...`);
    await page.goto(`https://couponfollow.com/site/${domain}`, {
      waitUntil: "networkidle2",
      timeout: CONFIG.navigationTimeout,
    });

    await log(`Page loaded for ${domain}, extracting coupon data...`);

    // Wait for coupon elements with better error handling
    try {
      await page.waitForSelector(".offer-card.regular-offer", {
        timeout: 8000,
      });
    } catch (err) {
      await log("Selector timeout, continuing with extraction", "WARN");
    }

    // Extract basic coupon data with modal URLs
    const { basicCoupons, modalUrls } = await page.evaluate(() => {
      const basicCoupons = [];
      const modalUrls = [];
      let idCounter = 1;

      const couponElements = document.querySelectorAll(
        ".offer-card.regular-offer"
      );

      console.log(`Found ${couponElements.length} offer cards`);

      couponElements.forEach((element) => {
        // Skip if not a coupon
        const dataType = element.getAttribute("data-type");
        if (dataType !== "coupon") {
          console.log(
            `Skipping non-coupon element with data-type: ${dataType}`
          );
          return;
        }

        const discountEl = element.querySelector(".offer-title");
        const termsEl = element.querySelector(".offer-description");

        const discount = discountEl?.textContent?.trim() || "Discount";
        const terms = termsEl?.textContent?.trim() || "Terms apply";
        const verified = element.getAttribute("data-is-verified") === "True";

        // Extract direct code if available in the element
        let code = "AUTOMATIC";

        // Try to get code from clipboard data or other attributes
        const showCodeBtn = element.querySelector(".show-code");
        if (showCodeBtn) {
          const dataCode =
            showCodeBtn.getAttribute("data-code") ||
            showCodeBtn.getAttribute("data-clipboard-text");
          if (dataCode) {
            code = dataCode;
          }
        }

        // Get the direct modal URL (not the hash URL)
        const modalUrl = element.getAttribute("data-modal");

        // Store element ID for debugging
        const elementId = element.getAttribute("id") || `coupon-${idCounter}`;

        basicCoupons.push({
          id: idCounter++,
          code,
          discount,
          terms,
          verified,
          source: "CouponFollow",
          elementId, // Store element ID for reference
        });

        modalUrls.push(modalUrl);
      });

      return { basicCoupons, modalUrls };
    });

    await log(
      `Found ${basicCoupons.length} basic coupons for ${domain}, processing modal URLs...`
    );

    // Process coupons with modal URLs to get the actual codes
    const completeCoupons = [...basicCoupons];

    // Close the initial page to save resources
    await page.close();

    // Process all coupons in batches
    if (modalUrls.length > 0) {
      const pendingCoupons = modalUrls
        .map((url, index) => ({
          url,
          index,
          coupon: basicCoupons[index],
        }))
        .filter((item) => item.url && item.coupon.code === "AUTOMATIC");

      const totalCoupons = pendingCoupons.length;
      const totalBatches = Math.ceil(totalCoupons / CONFIG.batchSize);

      await log(
        `Processing ${totalCoupons} modal URLs in ${totalBatches} batches of ${CONFIG.batchSize}`
      );

      // Process in batches
      for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
        const startIndex = batchIndex * CONFIG.batchSize;
        const endIndex = Math.min(startIndex + CONFIG.batchSize, totalCoupons);
        const currentBatchItems = pendingCoupons.slice(startIndex, endIndex);

        await log(
          `Processing batch ${batchIndex + 1}/${totalBatches} (modals ${
            startIndex + 1
          }-${endIndex})`
        );

        await processModalBatch(
          browser,
          currentBatchItems,
          Math.min(currentBatchItems.length, 3), // Maximum 3 concurrent pages
          CONFIG.modalTimeout,
          completeCoupons
        );
      }
    }

    // Clean up and return coupons without internal properties
    return completeCoupons.map((coupon) => {
      const { elementId, ...cleanCoupon } = coupon;
      return cleanCoupon;
    });
  } catch (error) {
    await logError(`Error scraping ${domain}`, error);

    // Retry logic
    if (retryCount < CONFIG.domainRetries) {
      await log(
        `Retrying ${domain} (attempt ${retryCount + 1}/${
          CONFIG.domainRetries
        })...`,
        "WARN"
      );
      await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait before retry
      return scrapeCoupons(domain, retryCount + 1);
    }
    return [];
  }
}

/**
 * Processes a batch of modals to extract coupon codes
 * @param {Browser} browser - Puppeteer browser instance
 * @param {Array} batchItems - Array of items to process
 * @param {number} concurrentLimit - Maximum number of concurrent pages
 * @param {number} timeout - Timeout for modal processing
 * @param {Array} completeCoupons - Array to update with extracted codes
 */
async function processModalBatch(
  browser,
  batchItems,
  concurrentLimit,
  timeout,
  completeCoupons
) {
  // Create a page pool for this batch
  const pagePool = [];
  for (let i = 0; i < Math.min(batchItems.length, concurrentLimit); i++) {
    const modalPage = await browser.newPage();

    // Set a realistic user agent
    await modalPage.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36"
    );

    // Enable JavaScript
    await modalPage.setJavaScriptEnabled(true);

    // Additional anti-detection measures for modal page
    await modalPage.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", {
        get: () => false,
      });
      window.navigator.chrome = { runtime: {} };
      window.navigator.permissions = {
        query: () => Promise.resolve({ state: "granted" }),
      };
    });

    // Selective resource blocking for modal pages
    await modalPage.setRequestInterception(true);
    modalPage.on("request", (req) => {
      const resourceType = req.resourceType();
      if (resourceType === "image" || resourceType === "font") {
        req.abort();
      } else {
        req.continue();
      }
    });

    pagePool.push(modalPage);
  }

  // Process each item in the batch with the page pool
  const batchPromises = [];

  for (let i = 0; i < batchItems.length; i++) {
    const item = batchItems[i];
    const modalPage = pagePool[i % pagePool.length]; // Cycle through the page pool

    batchPromises.push(
      (async () => {
        try {
          await log(
            `Processing modal for coupon ${item.index + 1} (Element ID: ${
              item.coupon.elementId || "unknown"
            })`
          );

          // Navigate directly to the modal URL
          await modalPage.goto(item.url, {
            waitUntil: ["load", "domcontentloaded"],
            timeout: timeout,
          });

          // Wait for potential code input fields to load
          try {
            await modalPage.waitForSelector(
              "input#code.input.code, input.input.code, .coupon-code, .code-text, [data-clipboard-text], [data-code]",
              {
                timeout: 5000,
              }
            );
          } catch (err) {
            await log(
              `No code input found for modal ${item.index + 1}`,
              "WARN"
            );
          }

          // Add a small delay to ensure dynamic content is loaded
          await modalPage.evaluate(() => {
            return new Promise((resolve) => setTimeout(resolve, 500));
          });

          // Extract the code from the modal using multiple approaches
          const code = await modalPage.evaluate(() => {
            // Try various selectors to find the code
            const selectors = [
              "input#code.input.code",
              "input.input.code",
              ".coupon-code",
              ".code-text",
              "[data-clipboard-text]",
              "[data-code]",
            ];

            // Try the selectors in order
            for (const selector of selectors) {
              const element = document.querySelector(selector);
              if (!element) continue;

              // Handle different element types
              if (element.tagName === "INPUT") {
                const value = element.value.trim();
                if (value) return value;
              } else {
                // For non-input elements, try data attributes first
                const clipboardText = element.getAttribute(
                  "data-clipboard-text"
                );
                if (clipboardText) return clipboardText.trim();

                const dataCode = element.getAttribute("data-code");
                if (dataCode) return dataCode.trim();

                // Last resort: use text content
                const textContent = element.textContent.trim();
                if (textContent) return textContent;
              }
            }

            // Return a Promise that resolves after a delay to try again
            return new Promise((resolve) => {
              setTimeout(() => {
                // Try once more after a short delay
                for (const selector of selectors) {
                  const element = document.querySelector(selector);
                  if (!element) continue;

                  if (element.tagName === "INPUT") {
                    const value = element.value.trim();
                    if (value) {
                      resolve(value);
                      return;
                    }
                  } else {
                    const clipboardText = element.getAttribute(
                      "data-clipboard-text"
                    );
                    if (clipboardText) {
                      resolve(clipboardText.trim());
                      return;
                    }

                    const dataCode = element.getAttribute("data-code");
                    if (dataCode) {
                      resolve(dataCode.trim());
                      return;
                    }

                    const textContent = element.textContent.trim();
                    if (textContent) {
                      resolve(textContent);
                      return;
                    }
                  }
                }

                resolve("AUTOMATIC"); // Default if no code found
              }, 500); // Wait 500ms before trying again
            });
          });

          // Update the coupon with the extracted code
          if (code && code !== "AUTOMATIC") {
            completeCoupons[item.index].code = code;
            await log(
              `Found code ${code} for coupon ${item.index + 1} (ID: ${
                item.coupon.elementId || "unknown"
              })`
            );
          } else {
            await log(
              `No code found for coupon ${item.index + 1} (ID: ${
                item.coupon.elementId || "unknown"
              })`,
              "WARN"
            );
          }
        } catch (error) {
          await logError(
            `Error processing modal for coupon ${item.index + 1}`,
            error
          );
        }
      })()
    );
  }

  // Wait for all modals in this batch to complete
  await Promise.all(batchPromises);

  // Close all pages in the pool
  for (const modalPage of pagePool) {
    await modalPage
      .close()
      .catch((err) => logError("Error closing modal page", err));
  }
}

/**
 * Saves coupon data to Supabase database
 * @param {string} domain - Domain name
 * @param {Array} coupons - Array of coupon objects
 * @returns {Promise<void>}
 */
async function saveToDatabase(domain, coupons, supabase) {
  // Prepare data for database
  const uniqueMap = new Map();

  coupons.forEach((coupon) => {
    const key = `${domain}:${coupon.code}`;
    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, {
        domain,
        code: coupon.code,
        discount: coupon.discount,
        terms: coupon.terms,
        verified: coupon.verified,
      });
    }
  });

  const uniqueCoupons = Array.from(uniqueMap.values());

  if (uniqueCoupons.length === 0) {
    await log(`No coupons to save for ${domain}`, "WARN");
    return;
  }

  // Save to Supabase
  try {
    await log(
      `Saving ${uniqueCoupons.length} coupons for ${domain} to database...`
    );

    const { data, error } = await supabase
      .from("coupons")
      .upsert(uniqueCoupons, {
        onConflict: ["domain", "code"],
        ignoreDuplicates: true,
      });

    if (error) {
      await logError(`Error saving coupons for ${domain} to database`, error);
    } else {
      await log(
        `Successfully saved ${uniqueCoupons.length} coupons for ${domain} to database`
      );
    }
  } catch (error) {
    await logError(`Exception saving coupons for ${domain} to database`, error);
  }
}

/**
 * API handler for Next.js API routes
 */
export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { domain } = req.body;

  if (!domain) {
    return res.status(400).json({ error: "Domain parameter is required" });
  }

  // Initialize Supabase client
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error(
      "Missing Supabase credentials. Please set SUPABASE_URL and SUPABASE_ANON_KEY environment variables."
    );
    return res.status(500).json({ error: "Server configuration error" });
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  // Send an immediate response to prevent timeout
  res.status(202).json({ message: "Scraping started" });

  // Continue processing asynchronously
  try {
    const coupons = await scrapeCoupons(domain);

    if (coupons.length > 0) {
      await saveToDatabase(domain, coupons, supabase);
      await log(
        `Successfully scraped and stored ${coupons.length} coupons for ${domain}`
      );
    } else {
      await log(`No coupons found for ${domain}`, "WARN");
    }
  } catch (error) {
    await logError(`Error scraping coupons for ${domain}`, error);
  }
}

/**
 * Main function to run the scraper for all domains in the alphabet
 */
async function main() {
  await log("Starting coupon scraper...");

  // Initialize Supabase client
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    await log(
      "Missing Supabase credentials. Please set SUPABASE_URL and SUPABASE_ANON_KEY environment variables.",
      "ERROR"
    );
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  // Define all alphabet letters including special characters
  const letters = [
    "a",
    "b",
    "c",
    "d",
    "e",
    "f",
    "g",
    "h",
    "i",
    "j",
    "k",
    "l",
    "m",
    "n",
    "o",
    "p",
    "q",
    "r",
    "s",
    "t",
    "u",
    "v",
    "w",
    "x",
    "y",
    "z",
    "0",
  ];

  let totalSuccessCount = 0;
  let totalErrorCount = 0;

  // Process each letter
  for (const letter of letters) {
    await log(`-------------------------------------------`);
    await log(`Starting to process domains for letter: ${letter}`);

    // Get all domains for this letter
    const domains = await scrapeDomains(letter);

    if (domains.length === 0) {
      await log(`No domains found for letter ${letter}, skipping...`, "WARN");
      continue;
    }

    await log(
      `Found ${domains.length} domains for letter ${letter}, starting to scrape coupons...`
    );

    let letterSuccessCount = 0;
    let letterErrorCount = 0;

    // Process domains in batches for concurrency
    for (let i = 0; i < domains.length; i += CONFIG.concurrentDomains) {
      const batch = domains.slice(i, i + CONFIG.concurrentDomains);
      await log(
        `Processing batch of ${batch.length} domains (${i + 1}-${Math.min(
          i + CONFIG.concurrentDomains,
          domains.length
        )} of ${domains.length})...`
      );

      const results = await Promise.all(
        batch.map(async (domain) => {
          try {
            await log(`Starting processing for domain: ${domain}`);

            const coupons = await scrapeCoupons(domain);

            if (coupons.length > 0) {
              await saveToDatabase(domain, coupons, supabase);
              await log(`Completed processing for domain: ${domain}`);
              return { success: true, domain };
            } else {
              await log(`No coupons found for ${domain}`, "WARN");
              await log(`Completed processing for domain: ${domain}`);
              return { success: false, domain };
            }
          } catch (error) {
            await logError(`Failed to process domain: ${domain}`, error);
            return { success: false, domain };
          }
        })
      );

      // Count successes and failures
      results.forEach((result) => {
        if (result.success) {
          letterSuccessCount++;
          totalSuccessCount++;
        } else {
          letterErrorCount++;
          totalErrorCount++;
        }
      });

      // Add a delay between batches to avoid overloading resources
      if (i + CONFIG.concurrentDomains < domains.length) {
        await log(
          `Waiting ${CONFIG.delayBetweenDomains}ms before next batch...`
        );
        await new Promise((resolve) =>
          setTimeout(resolve, CONFIG.delayBetweenDomains)
        );
      }
    }

    await log(
      `Letter ${letter} completed: ${letterSuccessCount} successes, ${letterErrorCount} failures`
    );

    // Add a longer delay between letters to avoid being detected as a bot
    if (letters.indexOf(letter) < letters.length - 1) {
      const delayBetweenLetters = CONFIG.delayBetweenDomains * 2; // Twice the domain delay
      await log(`Waiting ${delayBetweenLetters}ms before next letter...`);
      await new Promise((resolve) => setTimeout(resolve, delayBetweenLetters));
    }
  }

  await log(`----------------------------------------`);
  await log(`Full alphabet coupon scraping completed!`);
  await log(`Successfully processed: ${totalSuccessCount} domains`);
  await log(`Failed to process: ${totalErrorCount} domains`);

  // Exit with error code if all domains failed
  if (totalSuccessCount === 0) {
    await log("All domains failed to process", "ERROR");
    process.exit(1);
  }
}

// Export functions for testing and CLI usage
export { scrapeDomains, scrapeCoupons, saveToDatabase, main };

// Run main if called directly (not imported)
if (typeof require !== "undefined" && require.main === module) {
  main().catch((error) => {
    logError("Fatal error in main", error);
    process.exit(1);
  });
}
