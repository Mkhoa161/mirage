from mirage.watch.fingerprint import stat_fingerprint


def test_stat_fingerprint_joins_the_etag_and_the_size():
    assert stat_fingerprint("etag-1", "2026-01-01T00:00:00", 5) == "etag-1|5"


def test_stat_fingerprint_substitutes_the_stamp_without_an_etag():
    assert stat_fingerprint(None, "2026-01-01T00:00:00",
                            5) == "2026-01-01T00:00:00|5"


def test_stat_fingerprint_handles_missing_fields():
    assert stat_fingerprint(None, None, None) == "|None"


def test_a_stamp_move_alone_is_not_an_update_for_a_versioned_backend():
    # S3's single-part ETag and Dropbox's content_hash are
    # content-addressed: rewriting a file with identical bytes leaves
    # them alone while the stamp moves. Folding the stamp in would
    # report that idempotent rewrite as an UPDATE.
    assert stat_fingerprint("sha-1", "2026-01-01T00:00:00",
                            5) == stat_fingerprint("sha-1",
                                                   "2026-06-06T00:00:00", 5)


def test_a_size_change_moves_the_fingerprint_under_a_stale_etag():
    # Probed against Nextcloud 30: its WebDAV ETag comes off an mtime
    # with one-second granularity, so two writes inside the same second
    # answer the SAME etag and the SAME stamp even though the content
    # and its size changed. Returning the etag alone reported no change
    # at all, which is how a real update went missing whenever the
    # machine was fast enough to do both writes in one second.
    stale = "8be37ae2eb0f16878c29923fa9b189ee"
    stamp = "2026-09-15T13:44:50+00:00"
    assert stat_fingerprint(stale, stamp,
                            4) != stat_fingerprint(stale, stamp, 11)


def test_an_etag_change_moves_the_fingerprint_under_a_stale_size():
    # The mirror case, and why the etag stays in the composite: a
    # content rewrite that keeps the byte count is invisible to the
    # size and to a coarse stamp, and only the backend's own version
    # carries it.
    stamp = "2026-09-15T13:44:50+00:00"
    assert stat_fingerprint("etag-a", stamp,
                            7) != stat_fingerprint("etag-b", stamp, 7)
