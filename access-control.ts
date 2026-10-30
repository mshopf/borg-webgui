import argon2 from 'argon2';
import type { Request, Response, NextFunction } from 'express';
import type { ManagementStore } from './management-store';
import type { ManagedUser, AccessRight } from './management-schema';
import { allowed } from './management-schema';

export class AccessControl {
    private principals = new WeakMap<Request, ManagedUser> ();
    constructor (private store: ManagementStore) {}
    authenticate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const match = /^Basic ([A-Za-z0-9+/=]+)$/i.exec (req.headers.authorization ?? '');
        const decoded = match?.[1] ? Buffer.from (match[1], 'base64').toString ('utf8') : '';
        const colon = decoded.indexOf (':');
        const user = colon >= 0 ? this.store.snapshot ().users.find (item => item.id === decoded.slice (0, colon)) : undefined;
        let verified = false;
        if (user?.enabled) {
            try { verified = await argon2.verify (user.passwordHash, decoded.slice (colon + 1)); } catch { /* Invalid hashes fail closed. */ }
        }
        if (!verified || !user) {
            res.setHeader ('WWW-Authenticate', 'Basic realm="borg-backup", charset="UTF-8"');
            res.status (401).json ({ error: 'Authentication required' }); return;
        }
        this.principals.set (req, user); next ();
    };
    principal (req: Request): ManagedUser {
        const user = this.principals.get (req);
        if (!user) throw Object.assign (Error ('Authentication required'), { status: 401 });
        return user;
    }
    requireAdmin (req: Request): ManagedUser {
        const user = this.principal (req);
        if (!user.admin) throw Object.assign (Error ('Administrator access required'), { status: 403 });
        return user;
    }
    require (req: Request, backup: string, right: AccessRight): ManagedUser {
        const user = this.principal (req);
        if (!allowed (user, backup, right)) throw Object.assign (Error ('Access denied'), { status: 403 });
        return user;
    }
}
/** JSON + a non-simple header prevents cookie/basic-auth cross-site form submissions. */
export function protectMutation (req: Request, _res: Response, next: NextFunction): void {
    if (['GET', 'HEAD', 'OPTIONS'].includes (req.method)) { next (); return; }
    if (!req.is ('application/json')) { next (Object.assign (Error ('JSON content type required'), { status: 415 })); return; }
    const origin = req.headers.origin;
    if (origin && origin !== req.protocol + '://' + req.get ('host')) { next (Object.assign (Error ('Cross-origin writes are not allowed'), { status: 403 })); return; }
    if (req.path.startsWith ('/admin/') && req.headers['x-borg-admin'] !== '1') { next (Object.assign (Error ('Admin request header required'), { status: 403 })); return; }
    next ();
}
