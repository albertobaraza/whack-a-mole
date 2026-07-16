# Plain static site, no build step — just nginx serving the files directly.
FROM nginx:alpine

RUN apk upgrade --no-cache

COPY index.html /usr/share/nginx/html/index.html
COPY css/ /usr/share/nginx/html/css/
COPY js/ /usr/share/nginx/html/js/
COPY assets/ /usr/share/nginx/html/assets/
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
