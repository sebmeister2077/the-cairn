import os, sys
from dotenv import load_dotenv
load_dotenv('.env.local')
import psycopg2
conn = psycopg2.connect(os.environ['SUPABASE_DB_URL'])
cur = conn.cursor()
cur.execute("SELECT table_schema, table_name FROM information_schema.tables WHERE table_name ILIKE '%contrib%'")
print(cur.fetchall())
