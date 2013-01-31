import time, re, sys, os, os.path, glob
from pprint import pprint, pformat
import bottle
from bottle import (route, run, default_app, 
    response, Bottle, static_file, 
    jinja2_template as template, html_escape)

bottle.TEMPLATE_PATH = [os.path.join(os.path.realpath(os.path.dirname(__file__)), 'templates') ]

@route('/name/<name>')
def nameindex(name='Stranger'):
    return '<strong>Hello, %s!</strong>' % name
 
@route('/')
def index():
    return template('index.html')


wsgi_app=default_app()
if '__main__' == __name__:
    import readline, rlcompleter; readline.parse_and_bind("tab: complete")

    SITE_STATIC_FILES = '|'.join(map(re.escape, [
        'favicon.ico',
        'robots.txt'
    ]))
    @route('/static/<filename:path>')
    @route('/<filename:re:.*(%s)' % SITE_STATIC_FILES)
    def server_static(filename):
        return static_file(filename, root='static')

    __import__('BaseHTTPServer').BaseHTTPRequestHandler.address_string = lambda x:x.client_address[0]
    from django.utils import autoreload
    def dev_server():
        run(wsgi_app, host='0.0.0.0', port=8002, debug=True)
    autoreload.main(dev_server)
