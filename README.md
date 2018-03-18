This extension adds automatic imports for Google's Closure Library.
It add's ES6 style imports to the top of your Javascript or Typescript file, e.g.
import Component from 'goog:goog.ui.Component'
import * as dom from 'goog:goog.dom'

It will also scan your project for any clutz generated .d.ts and add autocomplete based on those:

import * as templates from 'goog:myproject.templates'
