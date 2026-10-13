// External services: known SDK imports + env var NAMES (never values).
import type { ExtractContext, Extractor, ExternalFact, Facts } from "../types";
import { isCodeFile, isTestFile, isSkipped, MAX_FILE_BYTES, safeRead, basename } from "./util";

/** import specifier (prefix match) → external name */
const SDKS: [RegExp, string][] = [
  [/^(stripe|@stripe\/)/, "stripe"], [/^@sendgrid\//, "sendgrid"], [/^resend$/, "resend"], [/^nodemailer$/, "smtp"], [/^postmark$/, "postmark"], [/^mailgun/, "mailgun"],
  [/^@aws-sdk\/client-s3$|^aws-sdk$|^boto3$|^s3fs$/, "s3"], [/^@aws-sdk\/client-ses$/, "ses"], [/^@aws-sdk\/client-sqs$/, "sqs"], [/^@aws-sdk\/client-sns$/, "sns"], [/^@aws-sdk\/client-dynamodb$|^@aws-sdk\/lib-dynamodb$/, "dynamodb"], [/^@aws-sdk\//, "aws"],
  [/^openai$/, "openai"], [/^@anthropic-ai\/sdk$|^anthropic$/, "anthropic"], [/^groq-sdk$|^groq$/, "groq"], [/^@google\/generative-ai$|^google\.generativeai$|^@google\/genai$/, "gemini"], [/^cohere/, "cohere"], [/^replicate$/, "replicate"], [/^langchain|^@langchain\//, "langchain"],
  [/^twilio$/, "twilio"], [/^firebase(-admin)?(\/|$)|^firebase_admin$/, "firebase"], [/^@supabase\//, "supabase"], [/^@clerk\//, "clerk"], [/^next-auth(\/|$)|^@auth\//, "next-auth"], [/^@auth0\/|^auth0/, "auth0"], [/^passport/, "passport"],
  [/^redis$|^ioredis$|^@redis\//, "redis"], [/^bullmq$|^bull$|^bee-queue$/, "bullmq"], [/^@upstash\/redis$/, "redis"], [/^@upstash\/qstash$/, "qstash"], [/^@upstash\//, "upstash"], [/^celery$/, "celery"], [/^kafkajs$|^kafka-python$/, "kafka"], [/^amqplib$|^pika$/, "rabbitmq"],
  [/^pusher(-js)?$/, "pusher"], [/^socket\.io(-client)?$/, "socket.io"], [/^ably$/, "ably"], [/^razorpay$/, "razorpay"], [/^@paypal\/|^paypal/, "paypal"], [/^braintree$/, "braintree"], [/^@lemonsqueezy\//, "lemonsqueezy"],
  [/^@sentry\//, "sentry"], [/^posthog/, "posthog"], [/^@segment\/|^analytics-node$/, "segment"], [/^mixpanel/, "mixpanel"], [/^@vercel\/blob$/, "vercel-blob"], [/^@vercel\/kv$/, "vercel-kv"], [/^cloudinary$/, "cloudinary"], [/^uploadthing(\/|$)/, "uploadthing"],
  [/^@slack\//, "slack"], [/^discord\.js$/, "discord"], [/^@octokit\//, "github"], [/^algoliasearch$/, "algolia"], [/^@elastic\/|^elasticsearch$/, "elasticsearch"], [/^@pinecone-database\//, "pinecone"], [/^@sanity\//, "sanity"], [/^contentful$/, "contentful"], [/^@notionhq\//, "notion"], [/^googleapis$/, "google-api"], [/^@googlemaps\//, "google-maps"], [/^mapbox-gl$/, "mapbox"],
];
/** env var name prefix → external */
const ENV_MAP: [RegExp, string][] = [
  [/^STRIPE_/, "stripe"], [/^SENDGRID_/, "sendgrid"], [/^RESEND_/, "resend"], [/^(SMTP_|MAIL_|EMAIL_SERVER)/, "smtp"], [/^POSTMARK_/, "postmark"], [/^MAILGUN_/, "mailgun"],
  [/^(AWS_S3_|S3_)/, "s3"], [/^AWS_/, "aws"], [/^OPENAI_/, "openai"], [/^ANTHROPIC_/, "anthropic"], [/^GROQ_/, "groq"], [/^(GEMINI_|GOOGLE_GENERATIVE|GOOGLE_AI_)/, "gemini"], [/^REPLICATE_/, "replicate"],
  [/^TWILIO_/, "twilio"], [/^(FIREBASE_|NEXT_PUBLIC_FIREBASE_)/, "firebase"], [/^(SUPABASE_|NEXT_PUBLIC_SUPABASE_)/, "supabase"], [/^(CLERK_|NEXT_PUBLIC_CLERK_)/, "clerk"], [/^(NEXTAUTH_|AUTH_SECRET|AUTH_URL|AUTH_TRUST_HOST|AUTH_GITHUB|AUTH_GOOGLE)/, "next-auth"], [/^AUTH0_/, "auth0"],
  [/^(REDIS_|UPSTASH_REDIS_|KV_URL|KV_REST)/, "redis"], [/^QSTASH_/, "qstash"], [/^KAFKA_/, "kafka"], [/^(RABBITMQ_|AMQP_)/, "rabbitmq"], [/^CELERY_/, "celery"],
  [/^(PUSHER_|NEXT_PUBLIC_PUSHER_)/, "pusher"], [/^RAZORPAY_/, "razorpay"], [/^PAYPAL_/, "paypal"], [/^BRAINTREE_/, "braintree"], [/^LEMONSQUEEZY_/, "lemonsqueezy"],
  [/^(SENTRY_|NEXT_PUBLIC_SENTRY_)/, "sentry"], [/^(POSTHOG_|NEXT_PUBLIC_POSTHOG_)/, "posthog"], [/^SEGMENT_/, "segment"], [/^MIXPANEL_/, "mixpanel"], [/^BLOB_READ_WRITE_TOKEN$/, "vercel-blob"], [/^CLOUDINARY_/, "cloudinary"], [/^UPLOADTHING_/, "uploadthing"],
  [/^SLACK_/, "slack"], [/^DISCORD_/, "discord"], [/^GITHUB_(TOKEN|APP|CLIENT|SECRET|WEBHOOK)/, "github"], [/^ALGOLIA_/, "algolia"], [/^ELASTIC/, "elasticsearch"], [/^PINECONE_/, "pinecone"], [/^SANITY_/, "sanity"], [/^CONTENTFUL_/, "contentful"], [/^NOTION_/, "notion"], [/^GOOGLE_MAPS_|^NEXT_PUBLIC_GOOGLE_MAPS/, "google-maps"], [/^MAPBOX_|^NEXT_PUBLIC_MAPBOX/, "mapbox"],
];

const JS_IMPORT = /(?:^|\n)\s*(?:import\s+(?:[\w*{}\s,$]+\s+from\s+)?|export\s+(?:[\w*{}\s,$]+\s+from\s+))["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)|import\(\s*["']([^"']+)["']\s*\)/g;
const PY_IMPORT = /(?:^|\n)\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/g;
const ENV_JS = /process\.env(?:\.(\w+)|\[\s*["'](\w+)["']\s*\])|import\.meta\.env\.(\w+)|\benv\.([A-Z][A-Z0-9_]{2,})\b|Deno\.env\.get\(\s*["'](\w+)["']/g;
const ENV_PY = /os\.(?:environ(?:\.get)?|getenv)\s*[\[(]\s*["'](\w+)["']|environ\.get\(\s*["'](\w+)["']|config\(\s*["'](\w+)["']/g;

function sdkFor(spec: string): string | undefined { for (const [re, n] of SDKS) if (re.test(spec)) return n; return undefined; }
function envFor(name: string): string | undefined { for (const [re, n] of ENV_MAP) if (re.test(name)) return n; return undefined; }

export const externalsExtractor: Extractor = {
  name: "externals",
  applies() { return true; },
  async run(ctx: ExtractContext): Promise<Partial<Facts>> {
    const externals: ExternalFact[] = [];
    const seen = new Set<string>();
    const push = (name: string, file: string, evidence: string) => { const k = `${name}|${file}|${evidence}`; if (!seen.has(k)) { seen.add(k); externals.push({ name, file, evidence }); } };
    for (const f of ctx.files) {
      const isPy = f.rel.endsWith(".py");
      const isEnv = /^\.env(\.example|\.sample|\.template|\.local\.example)?$/.test(basename(f.rel));
      if (isEnv) {
        if (/^\.env(\.local)?$/.test(basename(f.rel))) continue; // real env files: never read, names could still leak values via ordering; .env.example is enough
        const text = await safeRead(ctx, f.rel); if (text === undefined) continue;
        for (const m of text.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]+)\s*=/gm)) { const n = envFor(m[1]); if (n) push(n, f.rel, `env:${m[1]}`); }
        continue;
      }
      if (!(isCodeFile(f) || (isPy && !isSkipped(f.rel) && f.size <= MAX_FILE_BYTES)) || isTestFile(f.rel) || /\.d\.ts$/.test(f.rel)) continue;
      const text = await safeRead(ctx, f.rel); if (text === undefined) continue;
      try {
        if (isPy) {
          for (const m of text.matchAll(PY_IMPORT)) { const spec = (m[1] ?? m[2]).split(".")[0]; const n = sdkFor(spec); if (n) push(n, f.rel, `import:${spec}`); }
          for (const m of text.matchAll(ENV_PY)) { const v = m[1] ?? m[2] ?? m[3]; const n = envFor(v); if (n) push(n, f.rel, `env:${v}`); }
        } else {
          for (const m of text.matchAll(JS_IMPORT)) { const spec = m[1] ?? m[2] ?? m[3]; if (!spec || spec.startsWith(".") || spec.startsWith("@/")) continue; const n = sdkFor(spec); if (n) push(n, f.rel, `import:${spec}`); }
          for (const m of text.matchAll(ENV_JS)) { const v = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]; if (!v) continue; const n = envFor(v); if (n) push(n, f.rel, `env:${v}`); }
        }
      } catch (e) { ctx.log(`externals: failed on ${f.rel}: ${(e as Error).message}`, "warn"); }
    }
    ctx.log(`externals: ${externals.length} facts`);
    return { externals };
  },
};
