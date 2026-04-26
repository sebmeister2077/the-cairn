## Api key improvement plan

- find way to more securely save api keys on the frontend which are used by users (each user has 1 key)
- Log activity if more users try to use the Invite Links then the number of keys that have been generated (e.g. if 10 keys have been generated but 100 people are trying to use the invite links, then log this activity) or when the link is used after the expiration time, this will help us identify potential abuse and we can know which group of people are trying to abuse the system 
- Ability for admin to set a custom rate-limiter for each api-key or dynamic api-key generated through invite links
