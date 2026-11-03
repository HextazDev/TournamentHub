const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function getSupabaseStatus() {
  // Capture both stdout and stderr to handle cases where Supabase outputs to different streams
  const output = execSync('npx supabase status -o json 2>&1', { encoding: 'utf8' });

  // Try to parse the entire output as JSON first
  try {
    return JSON.parse(output);
  } catch (e) {
    // If that fails, try to extract JSON from the output
    const jsonStart = output.indexOf('{');
    const jsonEnd = output.lastIndexOf('}');

    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
      throw new Error(`Could not find JSON in Supabase status output. Output: ${output.substring(0, 200)}...`);
    }

    const jsonStr = output.substring(jsonStart, jsonEnd + 1);
    try {
      return JSON.parse(jsonStr);
    } catch (parseError) {
      throw new Error(`Failed to parse JSON from Supabase status output. Extracted: ${jsonStr}. Error: ${parseError.message}`);
    }
  }
}

function getSupabaseStatusWithRetries(retries = 10, delay = 2000) {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      return getSupabaseStatus();
    } catch (error) {
      lastError = error;
      if (i < retries - 1) {
        console.log(`⏳ Waiting for Supabase to be ready... (attempt ${i + 1}/${retries})`);
        // Sleep using execSync (Unix)
        execSync(`sleep ${Math.floor(delay / 1000)}`);
      }
    }
  }
  console.error("❌ Failed to get Supabase status after multiple attempts. Make sure Supabase is started (make supabase-start).", lastError.message);
  process.exit(1);
}

function updateEnvFile(filePath, examplePath, updates) {
  let content = "";
  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, 'utf8');
  } else if (fs.existsSync(examplePath)) {
    content = fs.readFileSync(examplePath, 'utf8');
  } else {
    content = Object.keys(updates).map(k => `${k}=`).join('\n') + '\n';
  }

  const lines = content.split(/\r?\n/);
  const updatedKeys = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#') || !line.includes('=')) continue;
    const eqIdx = line.indexOf('=');
    const key = line.slice(0, eqIdx).trim();
    if (updates.hasOwnProperty(key)) {
      lines[i] = `${key}=${updates[key]}`;
      updatedKeys.add(key);
    }
  }

  for (const key of Object.keys(updates)) {
    if (!updatedKeys.has(key)) {
      lines.push(`${key}=${updates[key]}`);
    }
  }

  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  console.log(`✅ Updated ${path.basename(filePath)} successfully.`);
}

console.log("🔄 Starting local environment configuration...");

const status = getSupabaseStatusWithRetries();

// Update Bot env
const botEnvPath = path.join(__dirname, '../apps/bot/.env');
const botExamplePath = path.join(__dirname, '../apps/bot/.env.example');
updateEnvFile(botEnvPath, botExamplePath, {
  SUPABASE_URL: status.API_URL,
  SUPABASE_KEY: status.ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
  BOT_API_SECRET: process.env.BOT_API_SECRET || "dev-bot-secret-key-123"
});

// Update Web env
const webEnvPath = path.join(__dirname, '../apps/web/.env.local');
const webExamplePath = path.join(__dirname, '../apps/web/.env.example');
updateEnvFile(webEnvPath, webExamplePath, {
  NEXT_PUBLIC_SUPABASE_URL: status.API_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: status.ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
  BOT_API_SECRET: process.env.BOT_API_SECRET || "dev-bot-secret-key-123",
  NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET || "dev-only-secret-do-not-use-in-production-environment"
});

console.log("🎉 Local configuration complete!");