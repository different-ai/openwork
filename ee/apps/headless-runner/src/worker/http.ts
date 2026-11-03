import axios from "axios"

// celld's Fetch runtime rejects browser-only Request options that Axios 1.20
// adds when constructing Request objects. Keep SDK requests on Axios's fetch
// path without those objects; authentication, bodies and abort signals remain
// part of the original request. This module is loaded only by the Worker.
axios.defaults.env = { ...axios.defaults.env, Request: null, Response: null }
