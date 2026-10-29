"""Security header values shared by the app and the browser tests."""
CSP = ("default-src 'self'; script-src 'self' https://huevo.su; style-src 'self'; img-src 'self' https: data:; "
       "connect-src 'self' https://huevo.su https://huevo.departament.site; base-uri 'none'; object-src 'none'; "
       "form-action 'self'; frame-ancestors 'self' https://huevo.su https://huevo.departament.site")
