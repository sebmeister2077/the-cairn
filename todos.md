# Todos

- add toast notifications for success and error messages in the frontend
- wrap every route in a try-except block to catch and log exceptions
- add logging configuration to log errors to a file (database maybe? and local log file as fallback)
- add a /health endpoint that returns a simple status message (e.g., "OK") to verify the server is running
- add signed URLs for secure access to uploaded files in R2
- Automatically give a score based on already existing map data (Spawn). Display the amount of chunks are overlapping & the overall similarity of the overlapping chunks (ex:300 chunks with 85% resemblance)
- Automatically display the regions with the most overlapping chunks (ex: top 5 regions with the most overlapping chunks) and also display for each region the similarity score of the overlapping chunks
- custom domain
- have a way to revert already merged changes in the map (e.g. if a user accidentally imports a wrong file, they can revert that import)
- SSL setup for secure access to the API (low priority, can be added later)
