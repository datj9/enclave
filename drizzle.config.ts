import { config as loadDotenv } from 'dotenv'
import { defineConfig } from 'drizzle-kit'

loadDotenv()

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined || databaseUrl === '') {
  throw new Error('DATABASE_URL is not set — copy .env.example to .env first')
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dbCredentials: { url: databaseUrl },
  strict: true,
  verbose: true,
})
