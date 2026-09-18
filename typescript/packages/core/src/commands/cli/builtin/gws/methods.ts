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

import type { TokenManager } from '../../../../core/google/client.ts'
import {
  calendarBase,
  docsBase,
  driveBase,
  formsBase,
  gmailBase,
  sheetsBase,
  slidesBase,
} from '../../../../core/google/client.ts'

// The official gws CLI generates one command per Discovery method and
// speaks raw API resources: `--params` carries path/query parameters,
// `--json` the request body, and the output is the API response JSON.
// Each entry here is one such passthrough method; the bespoke verbs
// (sheets read/write/append, docs write, the gmail helpers) stay
// hand-written beside them in the tree.

export type GwsService = 'drive' | 'docs' | 'sheets' | 'slides' | 'gmail' | 'calendar' | 'forms'

export interface GwsMethod {
  service: GwsService
  vfs: string
  method: string
  http: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  needsBody?: boolean
  rawBytes?: boolean
  // Where a newly created file lands when the installation is scoped to a
  // folder. 'parents' means the request body takes a parents array, so the
  // scope is filled in there. 'relocate' means the API has no parents field
  // at all (the editors' create methods), so the new file is moved
  // afterwards with a Drive update. Absent means the method creates nothing.
  placement?: 'parents' | 'relocate'
  // Response key holding the new file's id, for 'relocate'.
  idField?: string
}

export const GWS_METHODS: readonly GwsMethod[] = [
  {
    service: 'docs',
    vfs: 'documents',
    method: 'get',
    http: 'GET',
    path: '/documents/{documentId}',
  },
  {
    service: 'docs',
    vfs: 'documents',
    method: 'create',
    http: 'POST',
    path: '/documents',
    needsBody: true,
    placement: 'relocate',
    idField: 'documentId',
  },
  {
    service: 'docs',
    vfs: 'documents',
    method: 'batchUpdate',
    http: 'POST',
    path: '/documents/{documentId}:batchUpdate',
    needsBody: true,
  },
  {
    service: 'sheets',
    vfs: 'spreadsheets',
    method: 'get',
    http: 'GET',
    path: '/spreadsheets/{spreadsheetId}',
  },
  {
    service: 'sheets',
    vfs: 'spreadsheets',
    method: 'create',
    http: 'POST',
    path: '/spreadsheets',
    needsBody: true,
    placement: 'relocate',
    idField: 'spreadsheetId',
  },
  {
    service: 'sheets',
    vfs: 'spreadsheets',
    method: 'batchUpdate',
    http: 'POST',
    path: '/spreadsheets/{spreadsheetId}:batchUpdate',
    needsBody: true,
  },
  {
    service: 'slides',
    vfs: 'presentations',
    method: 'get',
    http: 'GET',
    path: '/presentations/{presentationId}',
  },
  {
    service: 'slides',
    vfs: 'presentations',
    method: 'create',
    http: 'POST',
    path: '/presentations',
    needsBody: true,
    placement: 'relocate',
    idField: 'presentationId',
  },
  {
    service: 'slides',
    vfs: 'presentations',
    method: 'batchUpdate',
    http: 'POST',
    path: '/presentations/{presentationId}:batchUpdate',
    needsBody: true,
  },
  { service: 'drive', vfs: 'files', method: 'list', http: 'GET', path: '/files' },
  { service: 'drive', vfs: 'files', method: 'get', http: 'GET', path: '/files/{fileId}' },
  {
    service: 'drive',
    vfs: 'files',
    method: 'create',
    http: 'POST',
    path: '/files',
    needsBody: true,
    placement: 'parents',
  },
  {
    service: 'drive',
    vfs: 'files',
    method: 'update',
    http: 'PATCH',
    path: '/files/{fileId}',
    needsBody: true,
  },
  {
    service: 'drive',
    vfs: 'files',
    method: 'copy',
    http: 'POST',
    path: '/files/{fileId}/copy',
    placement: 'parents',
  },
  {
    service: 'drive',
    vfs: 'files',
    method: 'delete',
    http: 'DELETE',
    path: '/files/{fileId}',
  },
  {
    service: 'drive',
    vfs: 'files',
    method: 'export',
    http: 'GET',
    path: '/files/{fileId}/export',
    rawBytes: true,
  },
  {
    service: 'drive',
    vfs: 'permissions',
    method: 'create',
    http: 'POST',
    path: '/files/{fileId}/permissions',
    needsBody: true,
  },
  {
    service: 'drive',
    vfs: 'permissions',
    method: 'list',
    http: 'GET',
    path: '/files/{fileId}/permissions',
  },
  {
    service: 'drive',
    vfs: 'permissions',
    method: 'delete',
    http: 'DELETE',
    path: '/files/{fileId}/permissions/{permissionId}',
  },
  {
    service: 'gmail',
    vfs: 'users labels',
    method: 'list',
    http: 'GET',
    path: '/users/{userId}/labels',
  },
  {
    service: 'gmail',
    vfs: 'users messages',
    method: 'list',
    http: 'GET',
    path: '/users/{userId}/messages',
  },
  {
    service: 'gmail',
    vfs: 'users messages',
    method: 'get',
    http: 'GET',
    path: '/users/{userId}/messages/{id}',
  },
  {
    service: 'gmail',
    vfs: 'users messages',
    method: 'send',
    http: 'POST',
    path: '/users/{userId}/messages/send',
    needsBody: true,
  },
  {
    service: 'gmail',
    vfs: 'users messages',
    method: 'trash',
    http: 'POST',
    path: '/users/{userId}/messages/{id}/trash',
  },
  {
    service: 'gmail',
    vfs: 'users messages attachments',
    method: 'get',
    http: 'GET',
    path: '/users/{userId}/messages/{messageId}/attachments/{id}',
  },
  {
    service: 'calendar',
    vfs: 'calendarList',
    method: 'list',
    http: 'GET',
    path: '/users/me/calendarList',
  },
  {
    service: 'calendar',
    vfs: 'calendars',
    method: 'get',
    http: 'GET',
    path: '/calendars/{calendarId}',
  },
  {
    service: 'calendar',
    vfs: 'events',
    method: 'list',
    http: 'GET',
    path: '/calendars/{calendarId}/events',
  },
  {
    service: 'calendar',
    vfs: 'events',
    method: 'get',
    http: 'GET',
    path: '/calendars/{calendarId}/events/{eventId}',
  },
  {
    service: 'calendar',
    vfs: 'events',
    method: 'insert',
    http: 'POST',
    path: '/calendars/{calendarId}/events',
    needsBody: true,
  },
  {
    service: 'calendar',
    vfs: 'events',
    method: 'patch',
    http: 'PATCH',
    path: '/calendars/{calendarId}/events/{eventId}',
    needsBody: true,
  },
  {
    service: 'calendar',
    vfs: 'events',
    method: 'delete',
    http: 'DELETE',
    path: '/calendars/{calendarId}/events/{eventId}',
  },
  {
    service: 'calendar',
    vfs: 'freebusy',
    method: 'query',
    http: 'POST',
    path: '/freeBusy',
    needsBody: true,
  },
  {
    service: 'forms',
    vfs: 'forms',
    method: 'create',
    http: 'POST',
    path: '/forms',
    needsBody: true,
    placement: 'relocate',
    idField: 'formId',
  },
  {
    service: 'forms',
    vfs: 'forms',
    method: 'get',
    http: 'GET',
    path: '/forms/{formId}',
  },
  {
    service: 'forms',
    vfs: 'forms',
    method: 'batchUpdate',
    http: 'POST',
    path: '/forms/{formId}:batchUpdate',
    needsBody: true,
  },
  {
    service: 'forms',
    vfs: 'forms responses',
    method: 'list',
    http: 'GET',
    path: '/forms/{formId}/responses',
  },
  {
    service: 'forms',
    vfs: 'forms responses',
    method: 'get',
    http: 'GET',
    path: '/forms/{formId}/responses/{responseId}',
  },
]

export function gwsMethodDescription(m: GwsMethod): string {
  return `${m.http} ${m.path} (Google ${m.service} API passthrough)`
}

export const SERVICE_BASES: Record<GwsService, (tm: TokenManager) => string> = {
  drive: driveBase,
  docs: docsBase,
  sheets: sheetsBase,
  slides: slidesBase,
  gmail: gmailBase,
  calendar: calendarBase,
  forms: formsBase,
}
