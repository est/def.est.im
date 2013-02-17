#!/usr/bin/env python
# coding: utf8

from iso639_1 import ISO639_1
from unicode_bmp import BMP
lookup=lambda w:filter(lambda x: w.lower() in x[0].lower(), BMP)
for name, nname, code in ISO639_1:
    t=lookup(name)
    if t:
        print name, code, ', '.join(x[1] for x in t) 
