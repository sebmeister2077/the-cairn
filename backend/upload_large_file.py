"""
Multipart upload helper for files >300MB to Cloudflare R2.
Usage: python upload_large_file.py <local_file_path> <r2_key>
Example: python upload_large_file.py globalservermap.db globalservermap.db
"""
import sys
import os
from pathlib import Path
from dotenv import load_dotenv
import boto3
from boto3.s3.transfer import TransferConfig

load_dotenv(Path(__file__).parent / "app" / ".env", override=False)
load_dotenv(Path(__file__).parent / ".env", override=False)

def main():
    if len(sys.argv) != 3:
        print("Usage: python upload_large_file.py <local_file_path> <r2_object_key>")
        sys.exit(1)

    local_path = sys.argv[1]
    r2_key = sys.argv[2]

    if not os.path.exists(local_path):
        print(f"Error: file not found: {local_path}")
        sys.exit(1)

    account_id = os.environ["R2_ACCOUNT_ID"]
    access_key = os.environ["R2_ACCESS_KEY_ID"]
    secret_key = os.environ["R2_SECRET_ACCESS_KEY"]
    bucket = os.environ["R2_BUCKET_NAME"]
    endpoint = f"https://{account_id}.r2.cloudflarestorage.com"

    s3 = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="auto",
    )

    file_size = os.path.getsize(local_path)
    print(f"Uploading {local_path} ({file_size / 1024**2:.1f} MB) -> {bucket}/{r2_key}")

    config = TransferConfig(
        multipart_threshold=50 * 1024 * 1024,   # 50 MB
        multipart_chunksize=50 * 1024 * 1024,    # 50 MB chunks
        max_concurrency=4,
    )

    s3.upload_file(local_path, bucket, r2_key, Config=config)
    print("Upload complete.")

if __name__ == "__main__":
    main()
