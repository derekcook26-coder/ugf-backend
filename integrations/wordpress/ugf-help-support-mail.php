<?php
/**
 * Plugin Name: UGF Help Support Mail
 * Description: Receives authenticated Help Center follow-up requests and emails staff@ugf.club.
 * Version: 1.0.0
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

const UGF_HELP_SUPPORT_RECIPIENT = 'staff@ugf.club';

function ugf_help_support_text( $value, $maximum ) {
	if ( ! is_string( $value ) ) {
		return '';
	}
	$value = sanitize_text_field( wp_unslash( $value ) );
	return mb_strlen( $value ) <= $maximum ? $value : '';
}

function ugf_help_support_permission( WP_REST_Request $request ) {
	if ( ! defined( 'UGF_HELP_SUPPORT_SECRET' ) || ! is_string( UGF_HELP_SUPPORT_SECRET ) || strlen( UGF_HELP_SUPPORT_SECRET ) < 32 ) {
		return new WP_Error( 'ugf_help_not_configured', 'Support delivery is unavailable.', array( 'status' => 503 ) );
	}
	$provided = $request->get_header( 'x-ugf-help-secret' );
	if ( ! is_string( $provided ) || ! hash_equals( UGF_HELP_SUPPORT_SECRET, $provided ) ) {
		return new WP_Error( 'ugf_help_forbidden', 'Forbidden.', array( 'status' => 403 ) );
	}
	return true;
}

function ugf_help_support_deliver( WP_REST_Request $request ) {
	$input = $request->get_json_params();
	if ( ! is_array( $input ) || ( $input['recipient'] ?? '' ) !== UGF_HELP_SUPPORT_RECIPIENT ) {
		return new WP_Error( 'ugf_help_invalid', 'Invalid request.', array( 'status' => 400 ) );
	}
	$first_name  = ugf_help_support_text( $input['firstName'] ?? '', 80 );
	$last_name   = ugf_help_support_text( $input['lastName'] ?? '', 80 );
	$email       = sanitize_email( $input['email'] ?? '' );
	$phone       = ugf_help_support_text( $input['phone'] ?? '', 24 );
	$topic       = ugf_help_support_text( $input['topic'] ?? '', 100 );
	$staff_label = ugf_help_support_text( $input['staffLabel'] ?? '', 40 );
	$location    = $input['location'] ?? '';
	if ( ! $first_name || ! $last_name || ! is_email( $email ) || ! $phone || ! $topic
		|| ! in_array( $staff_label, array( 'Existing member', 'Possible member' ), true )
		|| ! in_array( $location, array( 'black_hawk', 'rapid_valley' ), true ) ) {
		return new WP_Error( 'ugf_help_invalid', 'Invalid request.', array( 'status' => 400 ) );
	}
	$location_label = 'black_hawk' === $location ? 'Black Hawk' : 'Rapid Valley';
	$subject = sprintf( '[UGF Help] %s — %s', $staff_label, $topic );
	$message = implode( "\n", array(
		'Website Help Center follow-up request',
		'Staff routing: ' . $staff_label,
		'Topic: ' . $topic,
		'Name: ' . $first_name . ' ' . $last_name,
		'Email: ' . $email,
		'Phone: ' . $phone,
		'Location: ' . $location_label,
		'',
		'No GymMaster prospect was created for this support request.',
	) );
	$headers = array( 'Reply-To: ' . $first_name . ' ' . $last_name . ' <' . $email . '>' );
	if ( ! wp_mail( UGF_HELP_SUPPORT_RECIPIENT, $subject, $message, $headers ) ) {
		return new WP_Error( 'ugf_help_mail_failed', 'Support delivery is unavailable.', array( 'status' => 503 ) );
	}
	return rest_ensure_response( array( 'ok' => true ) );
}

add_action( 'rest_api_init', function () {
	register_rest_route( 'ugf/v1', '/help-followup', array(
		'methods'             => WP_REST_Server::CREATABLE,
		'callback'            => 'ugf_help_support_deliver',
		'permission_callback' => 'ugf_help_support_permission',
	) );
} );
