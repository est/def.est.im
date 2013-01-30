import time, re, sys, os, os.path, glob
from pprint import pprint, pformat
import bottle
from bottle import (route, run, default_app, 
    response, Bottle, static_file, 
    jinja2_template as template, html_escape)


@route('/name/<name>')
def nameindex(name='Stranger'):
    return '<strong>Hello, %s!</strong>' % name
 
@route('/')
def index():
    return '<strong>Hello World!</strong>'

# This must be added in order to do correct path lookups for the views
import os
from bottle import TEMPLATE_PATH
# TEMPLATE_PATH.append(os.path.join(os.environ['OPENSHIFT_HOMEDIR'], 
    # 'runtime/repo/wsgi/views/')) 

wsgi_app=default_app()



def dev_server():
    run(wsgi_app, host='0.0.0.0', port=8002, debug=True)

if '__main__' == __name__:
    import readline, rlcompleter; readline.parse_and_bind("tab: complete")

    __import__('BaseHTTPServer').BaseHTTPRequestHandler.address_string = lambda x:x.client_address[0]

    from django.utils import autoreload
    autoreload.main(dev_server)
