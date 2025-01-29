# Post screenshotter

[![Build Status](https://drone.allypost.net/api/badges/Allypost/twitter-screenshotter/status.svg)](https://drone.allypost.net/Allypost/twitter-screenshotter) [![Docker Image Size](https://img.shields.io/docker/image-size/allypost/twitshot)](https://hub.docker.com/r/allypost/twitshot)

This was a simple service to take screenshots of tweets.
But as time went on, it grew to encompass multiple different services.

Right now it supports:

- X/Twitter
- Tumblr
- Bluesky
- Mastodon
- Misskey
- Sharkey

Other than taking a screenshot of the post, it also does some post-processing like removing the "Follow" button and stuff like that.

## Usage

Take a look at the [example env file](./.env.example) for the environment variables.

Copy it to `.env` and fill in the values.

### Docker

To run the service, you can use the docker image:

```bash
docker run -p 8080:8080 allypost/twitshot
```

### Local

To run the service locally, you can use bun:

```bash
bun run src/index.ts
```

or use the compose files

```bash
docker-compose up --build --pull always --detach --wait
```
