<?php
/**
 * Plugin Name: AUS Academy - Portal Bridge
 * Description: Sends completed WooCommerce orders (Full Exam Papers, Study
 *              Material, and Tutorials) to the AUS Academy Node.js Student
 *              Portal, which auto-creates/links the student account and
 *              assigns the purchased item.
 * Version: 2.0
 *
 * SETUP:
 * 1. Save this file as a Must-Use plugin: wp-content/mu-plugins/aus-academy-woo-bridge.php
 *    (or install as a normal plugin in wp-content/plugins/).
 * 2. Below, set AUS_ACADEMY_PORTAL_URL to your Node app's public URL.
 * 3. Set AUS_ACADEMY_WEBHOOK_SECRET to the SAME value as WOO_WEBHOOK_SECRET
 *    in the Node app's .env file.
 * 4. Put each sellable WooCommerce product into ONE of these three
 *    categories, so this plugin knows what it is:
 *      - full-exam-papers   → matches an Exam Paper in the portal
 *      - study-material     → matches a Study Material lesson in the portal
 *      - tutorials          → matches a Tutorial in the portal
 *    (Alternatively, set a custom field on the product: aus_academy_type =
 *    exam_paper | study_material | tutorial — the category is just the
 *    easier way to do it in the WordPress product editor.)
 * 5. Note the WooCommerce product's ID (the number in the product edit URL,
 *    e.g. post=587) and enter that same number as "Woo Product ID" on the
 *    matching item inside the Node portal's Admin panel — Full Exam Papers /
 *    Study Material / Tutorials, whichever matches.
 * 6. MCQ Plans are NEVER sold here — they're portal-only. Don't put an MCQ
 *    Plan product in WooCommerce; this plugin only ever forwards the three
 *    types above.
 */

if (!defined('ABSPATH')) exit;

define('AUS_ACADEMY_PORTAL_URL', 'https://class.eglit.in');   // <-- your portal's domain
define('AUS_ACADEMY_WEBHOOK_SECRET', 'change-me-too');        // <-- must match .env WOO_WEBHOOK_SECRET

add_action('woocommerce_order_status_completed', 'aus_academy_send_order_to_portal', 20, 1);
// Some stores mark digital/virtual orders "processing" instead of "completed" — cover both.
add_action('woocommerce_order_status_processing', 'aus_academy_send_order_to_portal', 20, 1);

/** Works out which of the three portal product types this WooCommerce product is, or null if it's not one of ours. */
function aus_academy_detect_product_type($product_id) {
    $explicit = get_post_meta($product_id, 'aus_academy_type', true);
    if (in_array($explicit, array('exam_paper', 'study_material', 'tutorial'), true)) {
        return $explicit;
    }
    // Backward compatible with the original single-purpose custom field.
    if (get_post_meta($product_id, 'aus_academy_paper', true) === 'yes') return 'exam_paper';

    if (has_term('full-exam-papers', 'product_cat', $product_id)) return 'exam_paper';
    if (has_term('study-material', 'product_cat', $product_id)) return 'study_material';
    if (has_term('tutorials', 'product_cat', $product_id)) return 'tutorial';
    return null;
}

function aus_academy_send_order_to_portal($order_id) {
    $order = wc_get_order($order_id);
    if (!$order) return;

    // Avoid double-sending if both status hooks fire for the same order.
    if ($order->get_meta('_aus_academy_synced') === 'yes') return;

    foreach ($order->get_items() as $item) {
        $product = $item->get_product();
        if (!$product) continue;

        $product_type = aus_academy_detect_product_type($product->get_id());
        if (!$product_type) continue; // not one of ours — skip this line item

        $payload = array(
            'order_id'        => (string) $order->get_id(),
            'email'           => $order->get_billing_email(),
            'name'            => trim($order->get_billing_first_name() . ' ' . $order->get_billing_last_name()),
            'amount'          => (float) $item->get_total(),
            'currency'        => $order->get_currency(),
            'payment_method'  => $order->get_payment_method(),
            'woo_product_id'  => (string) $product->get_id(),
            'product_type'    => $product_type, // exam_paper | study_material | tutorial
            'product_title'   => $product->get_name(),
            'quantity'        => $item->get_quantity(),
        );

        $response = wp_remote_post(rtrim(AUS_ACADEMY_PORTAL_URL, '/') . '/api/woo/order-complete', array(
            'timeout' => 15,
            'headers' => array(
                'Content-Type'      => 'application/json',
                'x-webhook-secret'  => AUS_ACADEMY_WEBHOOK_SECRET,
            ),
            'body' => wp_json_encode($payload),
        ));

        if (is_wp_error($response)) {
            $order->add_order_note('AUS Academy portal sync failed (' . $product_type . '): ' . $response->get_error_message());
            continue;
        }

        $code = wp_remote_retrieve_response_code($response);
        $body = json_decode(wp_remote_retrieve_body($response), true);

        if ($code === 200 && !empty($body['ok'])) {
            $order->add_order_note('AUS Academy portal sync OK (' . $product_type . ') — assignment #' . ($body['assignment_id'] ?? '?'));
        } else {
            $order->add_order_note('AUS Academy portal sync error (' . $product_type . '): ' . wp_remote_retrieve_body($response));
        }
    }

    $order->update_meta_data('_aus_academy_synced', 'yes');
    $order->save();
}
