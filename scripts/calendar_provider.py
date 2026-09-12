import concurrent.futures
import datetime as dt
import html
import json
import os
from html.parser import HTMLParser
from pathlib import Path
import subprocess
from urllib.parse import urlencode, urljoin
from zoneinfo import ZoneInfo

class CalendarParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.active = 0
        self.rows = []
        self.row = None
        self.cell = None
        self.span = False
        self.anchor = None
        self.next_url = None
        self.raw = []
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'div':
            if attrs.get('id') == 'release-dates-pager': self.active = 1
            elif self.active: self.active += 1
        if tag == 'a': self.anchor = {'href': attrs.get('href', ''), 'text': ''}
        if not self.active: return
        if tag == 'tr': self.row = []; self.raw = []
        if self.row is not None: self.raw.append(self.get_starttag_text())
        if tag == 'td' and self.row is not None:
            self.cell = {'attrs': attrs, 'text': '', 'firstSpan': None, 'links': []}
        if tag == 'span' and self.cell is not None and self.cell['firstSpan'] is None:
            self.cell['firstSpan'] = ''; self.span = True
    def handle_data(self, data):
        if self.row is not None: self.raw.append(data)
        if self.cell is not None:
            self.cell['text'] += data
            if self.span: self.cell['firstSpan'] += data
        if self.anchor is not None: self.anchor['text'] += data
    def handle_endtag(self, tag):
        if self.row is not None: self.raw.append('</' + tag + '>')
        if tag == 'a' and self.anchor is not None:
            if self.cell is not None: self.cell['links'].append(self.anchor)
            if 'Next' in self.anchor['text']: self.next_url = self.anchor['href']
            self.anchor = None
        if tag == 'span': self.span = False
        if tag == 'td' and self.cell is not None:
            if self.row is not None: self.row.append(self.cell)
            self.cell = None
        if tag == 'tr' and self.row is not None:
            self.rows.append({'cells': self.row, 'html': ''.join(self.raw)})
            self.row = None
        if tag == 'div' and self.active: self.active -= 1


