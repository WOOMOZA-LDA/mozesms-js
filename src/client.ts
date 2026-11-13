import { HttpClient, type ClientOptions } from './http';
import { ApiLogs, Billing, Campaigns, ContactGroups, Contacts, Dashboard, Notifications, Reports, SenderIds, Templates } from './resources/management';
import { Account, Otp, Sms, Webhooks } from './resources/core';
import { WhatsApp } from './resources/whatsapp';

/**
 * Cliente da API MozeSMS. SÓ para o servidor (Node, Next.js route handlers, edge): guarda o secret.
 *
 *     const moze = new MozeSMS({ apiKey: process.env.MOZESMS_KEY!, apiSecret: process.env.MOZESMS_SECRET! });
 *     await moze.sms.send('846000000', 'Olá!', 'MozeSMS');
 *
 * Para React, use os hooks de '@woomoza/mozesms/react' com o handler de '@woomoza/mozesms/server'.
 */
export class MozeSMS {
  readonly sms: Sms;
  readonly otp: Otp;
  readonly account: Account;
  readonly webhooks: Webhooks;
  readonly senderIds: SenderIds;
  readonly billing: Billing;
  readonly contacts: Contacts;
  readonly groups: ContactGroups;
  readonly templates: Templates;
  readonly campaigns: Campaigns;
  readonly reports: Reports;
  readonly dashboard: Dashboard;
  readonly apiLogs: ApiLogs;
  readonly notifications: Notifications;
  readonly whatsapp: WhatsApp;

  constructor(options: ClientOptions) {
    const http = new HttpClient(options);
    this.sms = new Sms(http);
    this.otp = new Otp(http);
    this.account = new Account(http);
    this.webhooks = new Webhooks(http);
    this.senderIds = new SenderIds(http);
    this.billing = new Billing(http);
    this.contacts = new Contacts(http);
    this.groups = new ContactGroups(http);
    this.templates = new Templates(http);
    this.campaigns = new Campaigns(http);
    this.reports = new Reports(http);
    this.dashboard = new Dashboard(http);
    this.apiLogs = new ApiLogs(http);
    this.notifications = new Notifications(http);
    this.whatsapp = new WhatsApp(http);
  }
}
