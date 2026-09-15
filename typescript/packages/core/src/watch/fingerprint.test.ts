// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { describe, expect, it } from 'vitest'
import { statFingerprint } from './fingerprint.ts'

describe('statFingerprint', () => {
  it('joins the etag and the size', () => {
    expect(statFingerprint('etag-1', '2026-01-01T00:00:00', 5)).toBe('etag-1|5')
  })

  it('substitutes the stamp without an etag', () => {
    expect(statFingerprint(null, '2026-01-01T00:00:00', 5)).toBe('2026-01-01T00:00:00|5')
  })

  it('handles missing fields', () => {
    expect(statFingerprint(null, null, null)).toBe('|None')
  })

  it('does not move on a stamp change alone for a versioned backend', () => {
    // S3's single-part ETag and Dropbox's content_hash are
    // content-addressed: rewriting a file with identical bytes leaves
    // them alone while the stamp moves. Folding the stamp in would
    // report that idempotent rewrite as an UPDATE.
    expect(statFingerprint('sha-1', '2026-01-01T00:00:00', 5)).toBe(
      statFingerprint('sha-1', '2026-06-06T00:00:00', 5),
    )
  })

  it('moves on a size change under a stale etag', () => {
    // Probed against Nextcloud 30: its WebDAV ETag comes off an mtime
    // with one-second granularity, so two writes inside the same
    // second answer the SAME etag and the SAME stamp even though the
    // content and its size changed. Returning the etag alone reported
    // no change at all, which is how a real update went missing
    // whenever the machine was fast enough to do both writes in one
    // second.
    const stale = '8be37ae2eb0f16878c29923fa9b189ee'
    const stamp = '2026-09-15T13:44:50+00:00'
    expect(statFingerprint(stale, stamp, 4)).not.toBe(statFingerprint(stale, stamp, 11))
  })

  it('moves on an etag change under a stale size', () => {
    // The mirror case, and why the etag stays in the composite: a
    // content rewrite that keeps the byte count is invisible to the
    // size and to a coarse stamp, and only the backend's own version
    // carries it.
    const stamp = '2026-09-15T13:44:50+00:00'
    expect(statFingerprint('etag-a', stamp, 7)).not.toBe(statFingerprint('etag-b', stamp, 7))
  })
})
