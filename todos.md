# Todos

- add toast notifications for success and error messages in the frontend
- wrap every route in a try-except block to catch and log exceptions
- add logging configuration to log errors to a file (database maybe? and local log file as fallback)
- [x] add a /health endpoint that returns a simple status message (e.g., "OK") to verify the server is running
- [x] add signed URLs for secure access to uploaded files in R2
- Automatically give a score based on already existing map data (Spawn). Display the amount of chunks are overlapping & the overall similarity of the overlapping chunks (ex:300 chunks with 85% resemblance)
- Automatically display the regions with the most overlapping chunks (ex: top 5 regions with the most overlapping chunks) and also display for each region the similarity score of the overlapping chunks
-[x] custom domain
- have a way to revert already merged changes in the map (e.g. if a user accidentally imports a wrong file, they can revert that import)
- SSL setup for secure access to the API (low priority, can be added later)
- Add cookies banner to the frontend to comply with privacy regulations (e.g., GDPR) (Local storage counts as cookies, so we should inform users about it and get their consent before using local storage to persist query data)
- Add a loading spinner or progress bar to the frontend to indicate when data is being fetched or processed (e.g., when generating map levels or fetching chunk data)
-[x] Add Dark mode and a centralized theme to the frontend for better user experience


- Allow players to upload their waypoints (extract from client-chat.log file) and display them on the map (this will allow players to share their waypoints with others and also to have a visual representation of their waypoints on the map). Limit how many waypoints can be viewed at once by normal users. Admins can view all waypoints without limit. Waypoints should be displayed with their name, icon, and color on the map. Waypoints should also be searchable by name and filterable by icon and color. For normal users they have to set their approximate home location on the map and only waypoints within a certain radius of that location will be displayed. Admins can see all waypoints regardless of location for moderation purposes. waypoints are heavily filters and sanitized on upload to prevent abuse (e.g., a user uploading a file with 100k waypoints to crash the map). 

-[x] change how admins send api-keys to the server, apikeys should not be that easily visible in requests.
- Add a "Traverse mode" which lets users select a TL grouping and traverse it in either direction, after exit/entry of a TL you press Next ao that the map automatically shows you (WITHOUT YOU NEEDING TO SCROLL) where the next TL is
- Allow users to set up their own default page (e.g., they can choose to land on the map page, the stats page, or the settings page when they load the site at the domain root). Saved only client side in local storage, so it doesn't require user accounts or server-side storage.
- Refactor the Contribute_r2.py file


# Ways to monetize

- Donations (Patreon, Ko-fi, etc.)
- No ADS
- Freemium services (Higher rate limits,)